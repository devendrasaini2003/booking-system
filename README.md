# Team Resource / Meeting Room Booking

Next.js 16.2 (App Router) + TypeScript + Tailwind v4 + Zod + Supabase (Postgres 17, Auth, Realtime). Deploy on Vercel.

## Setup
1. Create a Supabase project (Postgres 17). Run `supabase/migrations/0001_init.sql` (SQL editor or `supabase db push`). It enables `btree_gist`.
2. Copy `.env.example` to `.env.local` and fill in URL + anon key.
3. `npm install && npm run dev`. Sign up, then promote yourself:
   `update profiles set role = 'admin' where email = 'you@example.com';`
4. Vercel: import repo, add the same two env vars, deploy. In Supabase Auth settings, add the Vercel URL as a redirect URL (and turn off email confirmation for quick testing).

## How double-booking is prevented
The guarantee lives in Postgres, not in app code. `bookings.during` is a `tstzrange` (`[)`, so back-to-back bookings are allowed) with:

    EXCLUDE USING gist (resource_id WITH =, during WITH &&) WHERE (status IN ('pending','approved'))

When two users submit the same slot at the same moment, both inserts reach the database; the GiST index forces them to serialize. The second transaction waits for the first, then fails with `exclusion_violation` (SQLSTATE 23P01). No check-then-insert exists anywhere. `create_booking()` catches that error, writes a `conflict` notification to the user and returns a clean `{ok:false, error}` to the UI. Rejected and cancelled rows fall outside the `WHERE`, so they free the slot.

## Recurring bookings
Materialized rows. `create_booking(resource, start, end, weeks)` inserts one row per week (start + 7d × i) in a single transaction, all sharing a `series_id`. If any occurrence conflicts, the whole series rolls back (no partial series). Why materialized rather than an RRULE: the exclusion constraint, availability queries, per-occurrence approval/cancel and `.ics` export all work on plain rows with no expansion logic. Trade-off: editing a whole series means updating N rows.

## State machine and permissions (RLS)
`booking_status` is a Postgres enum: pending / approved / rejected / cancelled. A `BEFORE` trigger (`bookings_guard`) sets the initial status server-side (pending if the resource needs approval, else approved), forces `user_id = auth.uid()`, freezes time/resource, and allows only these transitions: admin pending→approved/rejected, admin or owner →cancelled. A member calling the REST API to approve their own booking gets an exception. `profiles` has no update policy, so nobody can self-promote to admin. Notifications are written only by `SECURITY DEFINER` code; users can only read/mark-read their own.

## Real-time
`notifications` and `bookings` are in the `supabase_realtime` publication. The client subscribes over WebSocket (Postgres changes filtered by `user_id`). No polling.

## Choices
- Zod validates every form on the client. The DB (checks, trigger, RPC validation) is the real server-side boundary, since the browser talks to Supabase directly. With another week I'd add Next route handlers with Zod for the RPC calls.
- Single-page UI to keep scope on correctness.

## What I'd build next (1 more week)
- Week view and click-to-select slots on the timeline
- Cancel/edit an entire series at once
- Notify admins when a booking needs approval
- Automated concurrency test (two parallel RPC calls) and RLS tests with pgTAP
- Split page.tsx into components, server-side session handling with `@supabase/ssr`
