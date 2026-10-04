-- Postgres 17. Run via `supabase db reset` / `supabase db push`.
create extension if not exists btree_gist;

create type app_role as enum ('admin', 'member');
create type booking_status as enum ('pending', 'approved', 'rejected', 'cancelled');

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  role app_role not null default 'member'
);

create function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin insert into profiles (id, email) values (new.id, new.email); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

create function is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;

create table resources (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 100),
  description text,
  capacity int check (capacity > 0),
  requires_approval boolean not null default false,
  created_at timestamptz not null default now()
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resources on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  during tstzrange not null check (not isempty(during) and lower(during) is not null and upper(during) is not null),
  starts_at timestamptz generated always as (lower(during)) stored,
  ends_at timestamptz generated always as (upper(during)) stored,
  status booking_status not null default 'pending',
  series_id uuid,
  created_at timestamptz not null default now(),
  -- THE concurrency guarantee: Postgres rejects overlapping live bookings per resource.
  -- Rejected/cancelled rows are excluded from the constraint, so they free the slot.
  constraint no_double_booking exclude using gist (resource_id with =, during with &&)
    where (status in ('pending', 'approved'))
);
create index on bookings (user_id);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  type text not null check (type in ('confirmed', 'pending', 'rejected', 'cancelled', 'conflict')),
  message text not null,
  booking_id uuid references bookings on delete set null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index on notifications (user_id, created_at desc);

create function notify(uid uuid, t text, msg text, bid uuid default null) returns void
language sql security definer set search_path = public as $$
  insert into notifications (user_id, type, message, booking_id) values (uid, t, msg, bid) $$;
revoke execute on function notify from public, anon, authenticated;

-- State machine + server-controlled fields. Clients can never choose status/user.
create function bookings_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.user_id := coalesce(auth.uid(), new.user_id);
    new.status := case when (select requires_approval from resources where id = new.resource_id)
                       then 'pending' else 'approved' end;
    return new;
  end if;
  if (new.resource_id, new.during, new.user_id, new.series_id)
     is distinct from (old.resource_id, old.during, old.user_id, old.series_id) then
    raise exception 'Booking time/resource cannot be changed; cancel and rebook.';
  end if;
  if new.status = old.status then return new; end if;
  if is_admin() and ((old.status = 'pending' and new.status in ('approved', 'rejected'))
                  or (old.status in ('pending', 'approved') and new.status = 'cancelled')) then
    return new;
  elsif old.user_id = auth.uid() and old.status in ('pending', 'approved') and new.status = 'cancelled' then
    return new;
  end if;
  raise exception 'Illegal status change % -> %', old.status, new.status;
end $$;
create trigger bookings_guard_trg before insert or update on bookings for each row execute function bookings_guard();

create function bookings_notify() returns trigger language plpgsql security definer set search_path = public as $$
declare rname text; begin
  if new.status <> old.status then
    select name into rname from resources where id = new.resource_id;
    perform notify(new.user_id, new.status::text,
      format('Your booking of %s on %s was %s.', rname, to_char(lower(new.during), 'DD Mon HH24:MI'), new.status), new.id);
  end if;
  return new;
end $$;
create trigger bookings_notify_trg after update on bookings for each row execute function bookings_notify();

-- Book one slot or a weekly series atomically. All rows or none.
create function create_booking(p_resource uuid, p_start timestamptz, p_end timestamptz, p_weeks int default 1)
returns jsonb language plpgsql as $$
declare sid uuid := gen_random_uuid(); i int; first_id uuid; st booking_status; rname text; bid uuid;
begin
  if p_end <= p_start then return jsonb_build_object('ok', false, 'error', 'End must be after start.'); end if;
  if p_weeks < 1 or p_weeks > 26 then return jsonb_build_object('ok', false, 'error', 'Weeks must be 1-26.'); end if;
  if p_start < now() then return jsonb_build_object('ok', false, 'error', 'Cannot book in the past.'); end if;
  select name into rname from resources where id = p_resource;
  begin
    for i in 0 .. p_weeks - 1 loop
      insert into bookings (resource_id, user_id, during, series_id)
      values (p_resource, auth.uid(), tstzrange(p_start + (i * interval '7 days'), p_end + (i * interval '7 days'), '[)'),
              case when p_weeks > 1 then sid end)
      returning id, status into bid, st;
      first_id := coalesce(first_id, bid);
    end loop;
  exception when exclusion_violation then
    -- subtransaction rolled back: no partial series is left behind
    perform notify(auth.uid(), 'conflict',
      format('Could not book %s: slot %s is already taken.', rname, to_char(p_start, 'DD Mon HH24:MI')));
    return jsonb_build_object('ok', false, 'error', 'That slot (or one in the series) is already booked.');
  end;
  perform notify(auth.uid(), case when st = 'approved' then 'confirmed' else 'pending' end,
    format('%s booking for %s (%s slot%s).', case when st = 'approved' then 'Confirmed' else 'Pending approval:' end,
           rname, p_weeks, case when p_weeks > 1 then 's' else '' end), first_id);
  return jsonb_build_object('ok', true, 'status', st);
end $$;

-- RLS
alter table profiles enable row level security;
alter table resources enable row level security;
alter table bookings enable row level security;
alter table notifications enable row level security;

create policy "profile read" on profiles for select to authenticated using (id = auth.uid() or is_admin());
-- no UPDATE/INSERT policy on profiles: nobody can self-promote to admin via the API.

create policy "resources read" on resources for select to authenticated using (true);
create policy "resources admin write" on resources for all to authenticated using (is_admin()) with check (is_admin());

create policy "bookings read" on bookings for select to authenticated using (true); -- needed for availability view
create policy "bookings insert own" on bookings for insert to authenticated with check (user_id = auth.uid());
create policy "bookings update own or admin" on bookings for update to authenticated
  using (user_id = auth.uid() or is_admin()) with check (user_id = auth.uid() or is_admin());
-- trigger bookings_guard enforces which transitions each role may perform.

create policy "notif read own" on notifications for select to authenticated using (user_id = auth.uid());
create policy "notif mark read own" on notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Realtime
alter publication supabase_realtime add table notifications, bookings;

-- Make yourself admin after signing up:
--   update profiles set role = 'admin' where email = 'you@example.com';
