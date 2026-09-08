"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import {
  DRAW_CANVAS_SIZE,
  canvasPoint,
  completedStroke,
  hasVisibleInk,
  paintStroke,
  type DrawPoint,
  type DrawStroke,
} from "@/lib/draw/canvas";
import { drawLaunchSecret } from "@/lib/draw/launch";

type Props = { sessionId: string };
type Job = { id: string; state: string; previewUrl?: string; outputUrl?: string } | null;

const colors = ["#17231d", "#b45309", "#dc2626", "#2563eb", "#ffffff"];

export default function DrawStudio({ sessionId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activePointerRef = useRef<number | null>(null);
  const [strokes, setStrokes] = useState<DrawStroke[]>([]);
  const [redo, setRedo] = useState<DrawStroke[]>([]);
  const [current, setCurrent] = useState<DrawPoint[]>([]);
  const [color, setColor] = useState(colors[0]!);
  const [size, setSize] = useState(18);
  const [eraser, setEraser] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [job, setJob] = useState<Job>(null);
  const [message, setMessage] = useState("Draw something, add a prompt, then tap Generate.");
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const secret = drawLaunchSecret(window.location.hash);
    const endpoint = `/api/draw/sessions/${encodeURIComponent(sessionId)}`;
    const request = secret
      ? fetch(`${endpoint}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) })
      : fetch(`${endpoint}/status`, { cache: "no-store" });
    void request.then((response) => {
      if (!response.ok) {
        setMessage(secret ? "This drawing link expired. Send /draw again for a fresh link." : "Open this canvas from its iMessage link.");
        return;
      }
      setAuthorized(true);
      if (secret) {
        // Some Messages WebViews reject History API mutations. Authorization
        // has already moved into the HttpOnly cookie, so failure here is safe.
        try { history.replaceState(null, "", `/draw/${encodeURIComponent(sessionId)}`); } catch { /* constrained WebView */ }
      }
    }).catch(() => setMessage("COAST Draw could not connect. Try reopening the link."));
  }, [sessionId]);

  useEffect(() => {
    if (!authorized) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/status`, { cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<{ events?: Array<{ state: string; mediaId: string | null }> }> : null)
        .then((body) => {
          const event = body?.events?.at(-1);
          if (!event) return;
          setJob((value) => value ? { ...value, state: event.state, ...(event.mediaId ? { outputUrl: `/api/draw/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(event.mediaId)}` } : {}) } : value);
          setMessage(event.state === "ready_for_delivery" ? "Delivered to iMessage." : event.state === "submitting" ? "Generating…" : event.state === "admitted" ? "Preparing…" : event.state);
        }).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [authorized, sessionId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = DRAW_CANVAS_SIZE; canvas.height = DRAW_CANVAS_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, DRAW_CANVAS_SIZE, DRAW_CANVAS_SIZE);
    for (const stroke of strokes) paintStroke(ctx, stroke);
    if (current.length > 1) paintStroke(ctx, { points: current, color, width: size, erase: eraser });
  }, [strokes, current, color, size, eraser]);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return canvasPoint(event.clientX, event.clientY, rect);
  }
  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    activePointerRef.current = event.pointerId;
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* iMessage WebView may not support capture */ }
    setCurrent([point(event)]);
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (activePointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const next = point(event);
    setCurrent((value) => value.length >= 4_096 ? value : [...value, next]);
  }
  function end(event?: React.PointerEvent<HTMLCanvasElement>) {
    if (event && activePointerRef.current !== event.pointerId) return;
    const stroke = completedStroke(current, color, size, eraser);
    activePointerRef.current = null;
    if (stroke) setStrokes((value) => [...value, stroke]);
    setRedo([]);
    setCurrent([]);
  }
  async function generate() {
    if (!authorized) { setMessage("Open this card from the iMessage conversation first."); return; }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx || (!prompt.trim() && !hasVisibleInk(ctx.getImageData(0, 0, canvas.width, canvas.height).data))) { setMessage("Add a sketch or a prompt before generating."); return; }
    setMessage("Preparing…");
    const flattened = document.createElement("canvas");
    flattened.width = DRAW_CANVAS_SIZE; flattened.height = DRAW_CANVAS_SIZE;
    const flattenedContext = flattened.getContext("2d");
    if (!flattenedContext) { setMessage("The sketch could not be prepared. Try again."); return; }
    flattenedContext.fillStyle = "#ffffff";
    flattenedContext.fillRect(0, 0, DRAW_CANVAS_SIZE, DRAW_CANVAS_SIZE);
    flattenedContext.drawImage(canvas, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => flattened.toBlob(resolve, "image/png"));
    let mediaId: string | undefined;
    if (blob && ctx && hasVisibleInk(ctx.getImageData(0, 0, canvas.width, canvas.height).data)) {
      const upload = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/media`, { method: "POST", headers: { "content-type": "image/png" }, body: blob });
      if (!upload.ok) { setMessage("The sketch could not be uploaded. Try again."); return; }
      mediaId = (await upload.json() as { mediaId: string }).mediaId;
    }
    const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/generations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: crypto.randomUUID(), prompt: prompt.trim(), mediaId }),
    });
    if (!response.ok) { setMessage("That generation could not start. Try again in a moment."); return; }
    const body = await response.json() as { jobId: string; state: string };
    setJob({ id: body.jobId, state: body.state }); setMessage(body.state === "awaiting_payment" ? "Payment is needed before this generation can start." : "Generating…");
  }

  return <main className="draw-shell">
    <div className="draw-header"><div><p className="eyebrow">COAST DRAW</p><h1>Sketch a move</h1></div><span className="status">{job?.state ?? "Ready"}</span></div>
    <div className="draw-layout"><section className="canvas-wrap"><canvas ref={canvasRef} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} aria-label="Drawing canvas" /><div className="canvas-hint">1024 × 1024 canvas</div></section>
      <section className="controls"><label>Prompt (optional)<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Turn this sketch into…" /></label>
        <div className="palette">{colors.map((value) => <button key={value} className="swatch" style={{ background: value }} aria-label={`Use ${value}`} onClick={() => { setColor(value); setEraser(false); }} />)}</div>
        <label>Brush size <input type="range" min="4" max="64" value={size} onChange={(e) => setSize(Number(e.target.value))} /></label>
        <div className="toolbar"><button onClick={() => { setEraser((v) => !v); }} className={eraser ? "selected" : ""}>Eraser</button><button onClick={() => { setRedo((v) => [...v, strokes.at(-1)!]); setStrokes((v) => v.slice(0, -1)); }} disabled={strokes.length === 0}>Undo</button><button onClick={() => { const value = redo.at(-1); if (value) { setStrokes((v) => [...v, value]); setRedo((v) => v.slice(0, -1)); } }} disabled={redo.length === 0}>Redo</button><button onClick={() => { setStrokes([]); setRedo([]); }}>Clear</button></div>
        <button className="generate" onClick={() => void generate()} disabled={job?.state === "running" || job?.state === "submitting"}>Generate</button><p className="message" aria-live="polite">{message}</p>
        {job?.outputUrl && <img className="result" src={job.outputUrl} alt="Generated result" />}
      </section>
    </div>
    <style jsx>{` .draw-shell{min-height:100vh;background:#17231d;color:#f8f1df;padding:24px;box-sizing:border-box;font-family:ui-sans-serif,system-ui}.draw-header{max-width:960px;margin:0 auto 18px;display:flex;justify-content:space-between;align-items:end}.eyebrow{color:#f4b544;letter-spacing:.14em;font-size:12px;font-weight:700;margin:0 0 4px}h1{font-size:30px;margin:0}.status{color:#f4b544}.draw-layout{max-width:960px;margin:auto;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:22px}.canvas-wrap{background:#fff;border-radius:18px;padding:10px;position:relative;aspect-ratio:1}.canvas-wrap canvas{width:100%;height:100%;touch-action:none;display:block;border-radius:10px}.canvas-hint{position:absolute;bottom:16px;right:18px;color:#777;font-size:11px;background:#fff9;padding:3px 6px;border-radius:8px}.controls{display:flex;flex-direction:column;gap:14px}label{font-size:13px;color:#f5d998;display:flex;flex-direction:column;gap:7px}textarea{min-height:88px;border-radius:12px;border:1px solid #526357;background:#25352b;color:#fff;padding:12px;font:inherit;resize:vertical}.palette{display:flex;gap:10px}.swatch{width:28px;height:28px;border-radius:50%;border:2px solid #f8f1df;cursor:pointer}.toolbar{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}.toolbar button,.generate{border:0;border-radius:10px;padding:10px;background:#344a3b;color:#f8f1df;cursor:pointer}.toolbar button:disabled{opacity:.4}.toolbar .selected{outline:2px solid #f4b544}.generate{background:#f4b544;color:#17231d;font-weight:800;font-size:16px}.message{font-size:13px;color:#d8d1be;margin:0}.result{width:100%;border-radius:14px}@media(max-width:760px){.draw-shell{padding:14px}.draw-layout{display:flex;flex-direction:column}.controls{gap:12px}.draw-header{align-items:start}.canvas-wrap{border-radius:12px}}`}</style>
  </main>;
}
