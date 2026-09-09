"use client";
import { useCallback, useEffect, useState } from "react";
import styles from "./dashboard.module.css";

const sections = {
  jobs: "Creative jobs",
  interactions: "Turns",
  messages: "Messages",
  usage: "Free usage",
  payments: "Payments",
  paymentEvents: "Payment events",
  balances: "Credit balances",
  ledger: "Credit ledger",
  link: "Link connections",
  deliveries: "Delivery",
};
type Section = keyof typeof sections;
type Row = Record<string, string | number | null>;
type Result = { page: Row[]; isDone: boolean; continueCursor: string; updatedAt: number };
function label(key: string) { return key === "_id" ? "Record" : key.replace(/([A-Z])/g, " $1").replace(/At Ms$/, " at").replace(/ Cents$/, " (USD)"); }
function display(key: string, value: Row[string]) {
  if (value === null) return "—";
  if (key.endsWith("Cents") && typeof value === "number") return (value / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  if (key.endsWith("AtMs") && typeof value === "number") return new Date(value).toLocaleString();
  if (key.endsWith("ElapsedMs") && typeof value === "number") return `${(value / 1000).toFixed(1)}s`;
  return String(value);
}
export default function AdminDashboard() {
  const [section, setSection] = useState<Section>("jobs");
  const [result, setResult] = useState<Result | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Array<string | null>>([]);
  const [password, setPassword] = useState("");
  const [locked, setLocked] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const query = new URLSearchParams({ section }); if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/admin/records?${query}`, { cache: "no-store", ...(signal ? { signal } : {}) });
      if (signal?.aborted) return;
      if (response.status === 401) { setLocked(true); setResult(null); return; }
      if (!response.ok) throw new Error("Unable to refresh. Last successful data remains below.");
      const body = await response.json() as Result;
      if (signal?.aborted) return;
      setResult(body); setLocked(false); setError("");
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Unable to refresh"); }
  }, [section, cursor]);
  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void refresh(controller.signal), 0);
    const timer = setInterval(() => void refresh(controller.signal), 15_000);
    return () => { controller.abort(); clearTimeout(initial); clearInterval(timer); };
  }, [refresh]);
  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      if (!response.ok) { setError("Access key not accepted, or login is unavailable."); return; }
      setPassword(""); await refresh();
    } catch { setError("Couldn’t connect. Try again."); }
    finally { setBusy(false); }
  }
  const rows = (result?.page ?? []).filter((row) => Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(filter.toLowerCase())));
  const columns = Object.keys(result?.page[0] ?? {});
  return <main className={styles.shell}>
    <header className={styles.header}><div><p className={styles.eyebrow}>COAST / OPERATIONS</p><h1>A clear view of the coast.</h1><p>Activity, generation, and account health.</p></div>{!locked && <button onClick={async () => { const response = await fetch("/api/admin/session", { method: "DELETE" }); if (response.ok) { setLocked(true); setResult(null); } }}>Sign out</button>}</header>
    {locked ? <form onSubmit={login} className={styles.login}><h2>Admin access</h2><p>Enter your private operations access key. Sessions last eight hours.</p><label>Access key<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label><button disabled={busy}>{busy ? "Signing in…" : "Open dashboard"}</button><p role="alert">{error}</p></form> : <>
      <nav className={styles.nav}>{Object.entries(sections).map(([key, name]) => <button key={key} aria-current={section === key ? "page" : undefined} onClick={() => { setSection(key as Section); setCursor(null); setPrevious([]); setFilter(""); setResult(null); }}>{name}</button>)}</nav>
      <section className={styles.cards}><article><span>View</span><strong>{sections[section]}</strong><small>Newest records first</small></article><article><span>Records on this page</span><strong>{result?.page.length ?? "…"}</strong><small>Browse older records below</small></article><article><span>Last refreshed</span><strong>{result ? new Date(result.updatedAt).toLocaleTimeString() : "Loading…"}</strong><small>Refreshes every 15 seconds</small></article></section>
      <section className={styles.panel}><div className={styles.controls}><h2>{sections[section]}</h2><input aria-label="Filter current page" placeholder="Filter this page by user, state, or ID…" value={filter} onChange={(e) => setFilter(e.target.value)} /><button onClick={() => void refresh()}>Refresh</button></div>
        {section === "messages" && <p>Message metadata only. The dashboard excludes message bodies and provider message identifiers.</p>}
        {section === "usage" && <p>Each row is one reserved free generation. Image usage is shared by /draw and /imagine; video usage belongs to /zap.</p>}
        {section === "payments" && <p>Payment path is the recorded COAST order path. A Checkout order may have been paid using Link inside Stripe Checkout; it does not prove a connected-wallet purchase.</p>}
        {section === "paymentEvents" && <p>Verified Stripe events used for idempotent settlement. Event and payment identities are operational references, not payment credentials.</p>}
        {section === "balances" && <p>Available purchased balance from credit accounts. Reservations and reversals are recorded in the ledger. Free usage is tracked separately from purchased credit.</p>}
        {section === "link" && <p>Connection status does not confirm that merchant wallet charging is enabled or that a purchase was approved.</p>}
        {error && <p role="alert">{error}</p>}
        <div className={styles.table}><table><thead><tr>{columns.map((key) => <th key={key}>{label(key)}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={String(row._id)}>{columns.map((key) => <td key={key} title={String(row[key] ?? "")}>{display(key, row[key] ?? null)}</td>)}</tr>)}</tbody></table>{!result ? <p>Loading records…</p> : !rows.length && <p>No records match this view.</p>}</div>
        <footer className={styles.controls}><button disabled={!previous.length} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious((value) => value.slice(0, -1)); setResult(null); }}>Previous</button><span>Page {previous.length + 1} · Up to 50 records per page</span><button disabled={!result || result.isDone} onClick={() => { if (result) { setPrevious((value) => [...value, cursor]); setCursor(result.continueCursor); setResult(null); } }}>Older records</button></footer>
      </section><p className={styles.footnote}>Private operational records · Amounts in USD · Prompts, message contents, media, addresses, and wallet credentials are excluded.</p>
    </>}
  </main>;
}
