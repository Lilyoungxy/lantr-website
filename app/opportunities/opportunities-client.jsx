"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./opportunities.module.css";

const ACTIVE_STATUSES = new Set(["queued", "running"]);

function OpportunityCard({ item, onDecide, deciding }) {
  return (
    <article className={styles.card}>
      <h3>{item.title}</h3>
      {item.why_it_fits && <p>{item.why_it_fits}</p>}
      {item.source_excerpt && <blockquote>“{item.source_excerpt}”</blockquote>}
      <a className={styles.sourceLink} href={item.url} target="_blank" rel="noreferrer">Visit official source ↗</a>
      {onDecide && <div className={styles.actions}>
        <button type="button" onClick={() => onDecide(item, "approved")} disabled={deciding}>Approve</button>
        <button className={styles.reject} type="button" onClick={() => onDecide(item, "rejected")} disabled={deciding}>Reject</button>
      </div>}
    </article>
  );
}

function ProgressDetails({ job }) {
  const calls = job?.toolCalls || [];
  return <details className={styles.details} open={Boolean(calls.length)}>
    <summary>Research details</summary>
    <div className={styles.metrics}><span>⌕ {job?.searches || 0} searches</span><span>↗ {job?.pageReads || 0} sources read</span></div>
    <ol className={styles.callList}>{calls.map((call, index) => <li key={`${call.at || "call"}-${index}`}><b>{call.name.replaceAll("_", " ")}</b><span>{call.detail}</span></li>)}</ol>
  </details>;
}

export default function OpportunitiesClient() {
  const [password, setPassword] = useState("");
  const [approved, setApproved] = useState([]);
  const [newRows, setNewRows] = useState([]);
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [decidingId, setDecidingId] = useState(null);
  const timer = useRef(null);

  const loadApproved = useCallback(async () => {
    const response = await fetch("/api/opportunities/approved", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load opportunities.");
    setApproved(data);
  }, []);

  const loadNew = useCallback(async () => {
    setError("");
    const response = await fetch("/api/opportunities/new", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load review opportunities.");
    setNewRows(data);
  }, [password]);

  useEffect(() => { loadApproved().catch((nextError) => setError(nextError.message)); }, [loadApproved]);

  const checkProgress = useCallback(async (id) => {
    const response = await fetch(`/api/opportunities/${id}`, { cache: "no-store", headers: { "x-site-password": password } });
    const nextJob = await response.json();
    if (!response.ok) throw new Error(nextJob.error || "Could not check research progress.");
    setJob(nextJob);
    if (nextJob.status === "completed") await loadNew();
  }, [loadNew, password]);

  useEffect(() => {
    if (!jobId || !ACTIVE_STATUSES.has(job?.status)) return undefined;
    timer.current = window.setInterval(() => checkProgress(jobId).catch((nextError) => setError(nextError.message)), 3_000);
    return () => window.clearInterval(timer.current);
  }, [checkProgress, job?.status, jobId]);

  async function refresh(event) {
    event.preventDefault();
    setError(""); setJob(null); setJobId(null); setStarting(true);
    try {
      const response = await fetch("/api/opportunities", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start opportunity research.");
      setJobId(data.id);
      await checkProgress(data.id);
    } catch (nextError) { setError(nextError.message || "Could not start opportunity research."); }
    finally { setStarting(false); }
  }

  async function decide(item, status) {
    const previousNew = newRows;
    const optimistic = { ...item, status, decided_at: new Date().toISOString() };
    setNewRows((rows) => rows.filter((row) => row.id !== item.id));
    if (status === "approved") setApproved((rows) => [optimistic, ...rows]);
    setDecidingId(item.id);
    try {
      const response = await fetch("/api/opportunities/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id, password, status }) });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.error || "Could not save that decision.");
      if (status === "approved") setApproved((rows) => [saved, ...rows.filter((row) => row.id !== item.id)]);
    } catch (nextError) {
      setNewRows(previousNew);
      if (status === "approved") setApproved((rows) => rows.filter((row) => row.id !== item.id));
      setError(nextError.message || "Could not save that decision.");
    } finally { setDecidingId(null); }
  }

  async function cancel() {
    if (!jobId) return;
    try {
      const response = await fetch(`/api/opportunities/${jobId}`, { method: "DELETE", headers: { "x-site-password": password } });
      const nextJob = await response.json();
      if (!response.ok) throw new Error(nextJob.error || "Could not cancel research.");
      setJob(nextJob);
    } catch (nextError) { setError(nextError.message || "Could not cancel research."); }
  }

  const active = ACTIVE_STATUSES.has(job?.status) || (Boolean(jobId) && !job);
  return <main className={styles.page}><div className={styles.paper}>
    <header className={styles.header}><a className={styles.back} href="/">← back to Ary&apos;s corner</a><span className={styles.sparkle}>✦</span><p className={styles.kicker}>little opportunity scout</p><h1>Opportunities</h1><p className={styles.intro}>Carefully checked ideas, saved for later.</p></header>
    <section className={styles.results} aria-live="polite"><div className={styles.sectionHeading}><span className={styles.label}>approved</span><h2>Good possibilities</h2></div>{approved.length ? <div className={styles.cards}>{approved.map((item) => <OpportunityCard item={item} key={item.id} />)}</div> : <p className={styles.empty}>Nothing approved just yet.</p>}</section>
    <section className={styles.control}><form onSubmit={refresh}><label htmlFor="site-password">Site password</label><div className={styles.formRow}><input id="site-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={starting || active} /><button type="submit" disabled={starting || active}>{starting ? "Starting…" : "Refresh ✦"}</button></div></form><button className={styles.reviewButton} type="button" onClick={() => loadNew().catch((nextError) => setError(nextError.message))} disabled={!password || starting || active}>Show review queue</button>{active && <button className={styles.cancel} type="button" onClick={cancel}>Cancel research</button>}{error && <p className={styles.error} role="alert">{error}</p>}</section>
    {newRows.length > 0 && <section className={styles.results} aria-live="polite"><div className={styles.sectionHeading}><span className={styles.label}>to review</span><h2>New opportunities</h2></div><div className={styles.cards}>{newRows.map((item) => <OpportunityCard item={item} key={item.id} onDecide={decide} deciding={decidingId === item.id} />)}</div></section>}
    {job && <section className={styles.progress} aria-live="polite"><div className={styles.statusLine}><span className={styles.label}>{job.status === "completed" ? "all done" : job.phase?.replaceAll("_", " ") || "starting"}</span><strong>{job.status === "completed" ? "Research complete ♡" : job.status === "cancelled" ? "Research cancelled" : job.status === "error" ? "Research stopped" : "Looking carefully…"}</strong></div><ProgressDetails job={job} />{job.status === "error" && <p className={styles.error}>{job.error || "The research agent stopped unexpectedly."}</p>}</section>}
  </div></main>;
}
