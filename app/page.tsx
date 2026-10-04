"use client";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { createEvent } from "ics";
import { z } from "zod";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

const bookingForm = z
  .object({ start: z.string().min(1, "Pick a start time"), end: z.string().min(1, "Pick an end time"), weeks: z.coerce.number().int().min(1).max(26) })
  .refine((v) => new Date(v.end) > new Date(v.start), { message: "End must be after start", path: ["end"] });
const resourceForm = z.object({ name: z.string().trim().min(1).max(100), capacity: z.coerce.number().int().min(1).optional() });

type R = { id: string; name: string; description: string | null; capacity: number | null; requires_approval: boolean };
type B = { id: string; resource_id: string; user_id: string; starts_at: string; ends_at: string; status: string; resources?: { name: string } };
type N = { id: string; message: string; read: boolean; created_at: string; type: string };
const fmt = (s: string) => new Date(s).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const HOURS = [8, 20];

export default function Home() {
  const [uid, setUid] = useState<string | null>(null);
  const [role, setRole] = useState("member");
  const [cred, setCred] = useState({ email: "", password: "" });
  const [rs, setRs] = useState<R[]>([]);
  const [sel, setSel] = useState("");
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [bs, setBs] = useState<B[]>([]);
  const [mine, setMine] = useState<B[]>([]);
  const [pend, setPend] = useState<B[]>([]);
  const [ns, setNs] = useState<N[]>([]);
  const [bell, setBell] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [f, setF] = useState({ start: "", end: "", weeks: "1" });
  const [nr, setNr] = useState({ name: "", capacity: "", approval: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setUid(data.session?.user.id ?? null));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setUid(s?.user.id ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    if (!uid) return;
    const [p, r, m, n] = await Promise.all([
      sb.from("profiles").select("role").eq("id", uid).single(),
      sb.from("resources").select("*").order("name"),
      sb.from("bookings").select("*,resources(name)").eq("user_id", uid).order("starts_at"),
      sb.from("notifications").select("*").order("created_at", { ascending: false }).limit(30),
    ]);
    setRole(p.data?.role ?? "member");
    setRs(r.data ?? []);
    setSel((s) => s || r.data?.[0]?.id || "");
    setMine(m.data ?? []);
    setNs(n.data ?? []);
    if (p.data?.role === "admin") {
      const { data } = await sb.from("bookings").select("*,resources(name)").eq("status", "pending").order("starts_at");
      setPend(data ?? []);
    }
  }, [uid]);

  const loadDay = useCallback(async () => {
    if (!sel) return;
    const d0 = new Date(day + "T00:00");
    const d1 = new Date(d0.getTime() + 864e5);
    const { data } = await sb.from("bookings").select("*").eq("resource_id", sel).in("status", ["pending", "approved"])
      .gt("ends_at", d0.toISOString()).lt("starts_at", d1.toISOString());
    setBs(data ?? []);
  }, [sel, day]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { loadDay(); }, [loadDay]);

  // Real-time: WebSocket subscriptions (no polling).
  useEffect(() => {
    if (!uid) return;
    const ch = sb.channel("app-" + uid)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${uid}` },
        (p) => setNs((x) => [p.new as N, ...x]))
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, () => { loadDay(); refresh(); })
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [uid, loadDay, refresh]);

  async function auth(mode: "in" | "up") {
    const { error } = mode === "in" ? await sb.auth.signInWithPassword(cred) : await sb.auth.signUp(cred);
    setMsg(error ? error.message : mode === "up" ? "Account created. Sign in now." : "");
  }

  async function book(e: React.SyntheticEvent) {
    e.preventDefault();
    const v = bookingForm.safeParse(f);
    if (!v.success) return setMsg(v.error.issues[0].message);
    setBusy(true);
    const { data, error } = await sb.rpc("create_booking", {
      p_resource: sel, p_start: new Date(v.data.start).toISOString(), p_end: new Date(v.data.end).toISOString(), p_weeks: v.data.weeks,
    });
    setBusy(false);
    setMsg(error ? error.message : data.ok ? "Booked." : data.error);
    refresh(); loadDay();
  }

  async function addResource(e: React.SyntheticEvent) {
    e.preventDefault();
    const v = resourceForm.safeParse({ name: nr.name, capacity: nr.capacity || undefined });
    if (!v.success) return setMsg(v.error.issues[0].message);
    const { error } = await sb.from("resources").insert({ name: v.data.name, capacity: v.data.capacity ?? null, requires_approval: nr.approval });
    setMsg(error ? error.message : "Resource added.");
    setNr({ name: "", capacity: "", approval: false });
    refresh();
  }

  async function setStatus(id: string, status: string) {
    const { error } = await sb.from("bookings").update({ status }).eq("id", id);
    if (error) setMsg(error.message);
    refresh(); loadDay();
  }

  function downloadIcs(b: B) {
    const p = (s: string) => { const d = new Date(s); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()] as [number, number, number, number, number]; };
    const { value } = createEvent({ title: b.resources?.name ?? "Booking", start: p(b.starts_at), end: p(b.ends_at), startInputType: "utc", startOutputType: "utc", endInputType: "utc", endOutputType: "utc" });
    if (!value) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([value], { type: "text/calendar" }));
    a.download = "booking.ics";
    a.click();
  }

  async function markRead() {
    setBell((o) => !o);
    const ids = ns.filter((n) => !n.read).map((n) => n.id);
    if (ids.length) { await sb.from("notifications").update({ read: true }).in("id", ids); setNs((x) => x.map((n) => ({ ...n, read: true }))); }
  }

  const inp = "border border-stone-400 bg-white px-2 py-1.5 rounded-sm text-sm";
  const btn = "bg-teal-800 text-white px-3 py-1.5 rounded-sm text-sm hover:bg-teal-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-800";

  if (!uid)
    return (
      <main className="max-w-sm mx-auto mt-24 p-6 space-y-3">
        <h1 className="text-2xl font-semibold">Room booking</h1>
        <input className={inp + " w-full"} placeholder="Email" value={cred.email} onChange={(e) => setCred({ ...cred, email: e.target.value })} />
        <input className={inp + " w-full"} type="password" placeholder="Password" value={cred.password} onChange={(e) => setCred({ ...cred, password: e.target.value })} />
        <div className="flex gap-2"><button className={btn} onClick={() => auth("in")}>Sign in</button><button className={btn + " !bg-stone-600"} onClick={() => auth("up")}>Create account</button></div>
        {msg && <p role="alert" className="text-sm text-red-700">{msg}</p>}
      </main>
    );

  const d0 = new Date(day + "T00:00").getTime();
  const span = HOURS[1] - HOURS[0];
  const pos = (s: string) => Math.min(100, Math.max(0, ((new Date(s).getTime() - d0) / 36e5 - HOURS[0]) / span * 100));
  const unread = ns.filter((n) => !n.read).length;
  const cur = rs.find((r) => r.id === sel);

  return (
    <main className="max-w-4xl mx-auto p-4 space-y-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Room booking {role === "admin" && <span className="text-sm text-teal-800">(admin)</span>}</h1>
        <div className="flex items-center gap-3 relative">
          <button onClick={markRead} aria-label="Notifications" className="border border-stone-400 px-3 py-1 rounded-sm text-sm">Notifications{unread > 0 && ` (${unread})`}</button>
          <button className="text-sm underline" onClick={() => sb.auth.signOut()}>Sign out</button>
          {bell && (
            <ul className="absolute right-0 top-10 w-80 max-h-80 overflow-auto bg-white border border-stone-400 z-10 shadow">
              {ns.length === 0 && <li className="p-3 text-sm text-stone-500">Nothing yet. Booking updates show up here.</li>}
              {ns.map((n) => (
                <li key={n.id} className={`p-3 text-sm border-b ${n.type === "conflict" || n.type === "rejected" ? "text-red-800" : ""}`}>{n.message}<div className="text-xs text-stone-500">{fmt(n.created_at)}</div></li>
              ))}
            </ul>
          )}
        </div>
      </header>
      {msg && <p role="status" className="text-sm bg-amber-100 border border-amber-400 px-3 py-2">{msg}</p>}

      <section className="space-y-3">
        <div className="flex gap-3 flex-wrap items-end">
          <label className="text-sm">Resource<br />
            <select className={inp} value={sel} onChange={(e) => setSel(e.target.value)}>{rs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <label className="text-sm">Day<br /><input type="date" className={inp} value={day} onChange={(e) => setDay(e.target.value)} /></label>
          {cur && <p className="text-sm text-stone-600">{cur.capacity ? `Seats ${cur.capacity}. ` : ""}{cur.requires_approval ? "Needs admin approval." : "Confirmed instantly."}</p>}
        </div>
        {rs.length === 0 && <p className="text-sm text-stone-600">No resources yet. {role === "admin" ? "Add one below." : "Ask an admin to add one."}</p>}
        <div className="relative h-12 bg-stone-100 border border-stone-300" aria-label="Day timeline">
          {Array.from({ length: span }, (_, i) => <div key={i} className="absolute top-0 bottom-0 border-l border-stone-300 text-[10px] pl-0.5 text-stone-500" style={{ left: `${(i / span) * 100}%` }}>{HOURS[0] + i}</div>)}
          {bs.map((b) => (
            <div key={b.id} title={`${fmt(b.starts_at)} – ${fmt(b.ends_at)} (${b.status})`}
              className={`absolute top-4 bottom-0 ${b.status === "pending" ? "bg-amber-400" : "bg-teal-800"}`}
              style={{ left: `${pos(b.starts_at)}%`, width: `${Math.max(1, pos(b.ends_at) - pos(b.starts_at))}%` }} />
          ))}
        </div>
        <p className="text-xs text-stone-500">Teal = booked, amber = pending approval. Empty = free.</p>
      </section>

      <form onSubmit={book} className="flex gap-3 flex-wrap items-end">
        <label className="text-sm">Start<br /><input type="datetime-local" className={inp} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
        <label className="text-sm">End<br /><input type="datetime-local" className={inp} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label>
        <label className="text-sm">Repeat weekly for<br /><input type="number" min={1} max={26} className={inp + " w-20"} value={f.weeks} onChange={(e) => setF({ ...f, weeks: e.target.value })} /> weeks</label>
        <button className={btn} disabled={busy || !sel}>{busy ? "Booking…" : "Book slot"}</button>
      </form>

      <section>
        <h2 className="font-semibold mb-2">My bookings</h2>
        {mine.length === 0 && <p className="text-sm text-stone-600">No bookings yet. Pick a resource and a time above.</p>}
        <ul className="divide-y border-y">
          {mine.map((b) => (
            <li key={b.id} className="py-2 flex justify-between items-center text-sm gap-2">
              <span>{b.resources?.name}: {fmt(b.starts_at)} – {new Date(b.ends_at).toLocaleTimeString([], { timeStyle: "short" })} <b>[{b.status}]</b></span>
              <span className="flex gap-3">
                {b.status === "approved" && <button className="underline" onClick={() => downloadIcs(b)}>.ics</button>}
                {(b.status === "pending" || b.status === "approved") && <button className="underline text-red-800" onClick={() => setStatus(b.id, "cancelled")}>Cancel</button>}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {role === "admin" && (
        <>
          <section>
            <h2 className="font-semibold mb-2">Pending approvals</h2>
            {pend.length === 0 && <p className="text-sm text-stone-600">Nothing waiting for approval.</p>}
            <ul className="divide-y border-y">
              {pend.map((b) => (
                <li key={b.id} className="py-2 flex justify-between text-sm"><span>{b.resources?.name}: {fmt(b.starts_at)}</span>
                  <span className="flex gap-3"><button className="underline" onClick={() => setStatus(b.id, "approved")}>Approve</button><button className="underline text-red-800" onClick={() => setStatus(b.id, "rejected")}>Reject</button></span></li>
              ))}
            </ul>
          </section>
          <form onSubmit={addResource} className="flex gap-3 flex-wrap items-end">
            <h2 className="font-semibold w-full">Add resource</h2>
            <input className={inp} placeholder="Name" value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} />
            <input className={inp + " w-24"} placeholder="Capacity" value={nr.capacity} onChange={(e) => setNr({ ...nr, capacity: e.target.value })} />
            <label className="text-sm"><input type="checkbox" checked={nr.approval} onChange={(e) => setNr({ ...nr, approval: e.target.checked })} /> Needs approval</label>
            <button className={btn}>Add resource</button>
          </form>
        </>
      )}
    </main>
  );
}
