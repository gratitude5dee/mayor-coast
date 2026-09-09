"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DRAW_CANVAS_SIZE,
  DRAW_IMPORT_MAX_BYTES,
  canvasPoint,
  completedStroke,
  containImage,
  drawJobLabel,
  hasVisibleInk,
  isDrawJobActive,
  paintStroke,
  type DrawPoint,
  type DrawStroke,
} from "@/lib/draw/canvas";
import { drawLaunchSecret } from "@/lib/draw/launch";
import type { DrawMode } from "@/lib/draw/provider";

type Props = { sessionId: string };
type Job = { id: string; state: string; outputUrl?: string; previewUrl?: string } | null;
type EventItem = { jobId: string; sequence: number; kind: string; state: string; mediaId: string | null; previewIndex: number | null; errorCode: string | null };

const colors = ["#17231d", "#b45309", "#dc2626", "#2563eb", "#ffffff"];
const mediaUrl = (sessionId: string, mediaId: string) => `/api/draw/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(mediaId)}`;

export default function DrawStudio({ sessionId }: Props) {
  const strokeCanvasRef = useRef<HTMLCanvasElement>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<number | null>(null);
  const currentRef = useRef<DrawPoint[]>([]);
  const strokesRef = useRef<DrawStroke[]>([]);
  const redoRef = useRef<DrawStroke[]>([]);
  const lastSequenceRef = useRef(0);
  const requestKeyRef = useRef<string | null>(null);
  const backgroundUrlRef = useRef<string | null>(null);
  const [strokes, setStrokes] = useState<DrawStroke[]>([]);
  const [redo, setRedo] = useState<DrawStroke[]>([]);
  const [current, setCurrent] = useState<DrawPoint[]>([]);
  const [color, setColor] = useState(colors[0]!);
  const [size, setSize] = useState(18);
  const [eraser, setEraser] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<DrawMode>("fast");
  const [job, setJob] = useState<Job>(null);
  const [tab, setTab] = useState<"sketch" | "preview">("sketch");
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("Add a sketch or prompt, then tap Generate.");
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => { strokesRef.current = strokes; }, [strokes]);
  useEffect(() => { redoRef.current = redo; }, [redo]);
  useEffect(() => { backgroundUrlRef.current = backgroundUrl; }, [backgroundUrl]);

  const applyEvent = useCallback((event: EventItem) => {
    if (event.sequence <= lastSequenceRef.current) return;
    lastSequenceRef.current = event.sequence;
    const nextId = event.jobId;
    setJob((previous) => ({ id: nextId || previous?.id || "", state: event.state, ...(previous?.outputUrl ? { outputUrl: previous.outputUrl } : {}), ...(event.kind === "preview" && event.mediaId ? { previewUrl: mediaUrl(sessionId, event.mediaId) } : {}), ...(event.kind === "completed" && event.mediaId ? { outputUrl: mediaUrl(sessionId, event.mediaId) } : {}) }));
    if (event.kind === "preview" && event.mediaId) setTab("preview");
    if (event.kind === "completed" && event.mediaId) { setTab("preview"); setMessage("Image ready. Sending it to iMessage…"); }
    else setMessage(drawJobLabel(event.state));
    if (["delivered", "failed", "terminal_failure", "refused", "cancelled", "expired"].includes(event.state)) requestKeyRef.current = null;
  }, [sessionId]);

  const refreshStatus = useCallback(async () => {
    const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/status`, { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json() as { events?: EventItem[]; activeJobId?: string | null; latestJobId?: string | null };
    for (const event of body.events ?? []) applyEvent(event);
    if (body.activeJobId) setJob((previous) => previous ?? { id: body.activeJobId!, state: "running" });
  }, [applyEvent, sessionId]);

  useEffect(() => {
    const secret = drawLaunchSecret(window.location.hash);
    const endpoint = `/api/draw/sessions/${encodeURIComponent(sessionId)}`;
    const request = secret
      ? fetch(`${endpoint}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) })
      : fetch(`${endpoint}/status`, { cache: "no-store" });
    void request.then((response) => {
      if (!response.ok) { setMessage(secret ? "This drawing link expired. Send /draw again." : "Open this canvas from its iMessage link."); return; }
      setAuthorized(true);
      if (secret) { try { history.replaceState(null, "", `/draw/${encodeURIComponent(sessionId)}`); } catch { /* constrained Messages webview */ } }
      void refreshStatus();
    }).catch(() => setMessage("COAST Draw could not connect. Try reopening the link."));
  }, [refreshStatus, sessionId]);

  useEffect(() => {
    if (!authorized) return;
    const source = new EventSource(`/api/draw/sessions/${encodeURIComponent(sessionId)}/events?after=${lastSequenceRef.current}`);
    const handle = (event: MessageEvent<string>) => { try { applyEvent(JSON.parse(event.data) as EventItem); } catch { /* ignore malformed keep-alives */ } };
    source.addEventListener("state", handle); source.addEventListener("preview", handle); source.addEventListener("completed", handle);
    const poll = window.setInterval(() => void refreshStatus(), 2_000);
    return () => { source.close(); window.clearInterval(poll); };
  }, [applyEvent, authorized, refreshStatus, sessionId]);

  useEffect(() => {
    const canvas = strokeCanvasRef.current;
    if (!canvas) return;
    try {
      canvas.width = DRAW_CANVAS_SIZE; canvas.height = DRAW_CANVAS_SIZE;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, DRAW_CANVAS_SIZE, DRAW_CANVAS_SIZE);
      for (const stroke of strokes) paintStroke(context, stroke);
      if (current.length > 1) paintStroke(context, { points: current, color, width: size, erase: eraser });
    } catch { return; }
  }, [color, current, eraser, size, strokes]);

  useEffect(() => {
    const canvas = backgroundCanvasRef.current;
    if (!canvas) return;
    try {
      canvas.width = DRAW_CANVAS_SIZE; canvas.height = DRAW_CANVAS_SIZE;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, DRAW_CANVAS_SIZE, DRAW_CANVAS_SIZE);
      if (!backgroundUrl) return;
      const image = new Image();
      image.onload = () => {
        try {
          if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
          const fit = containImage(image.naturalWidth, image.naturalHeight);
          context.drawImage(image, fit.x, fit.y, fit.width, fit.height);
        } catch { setMessage("The imported image could not be displayed. Try another image."); }
      };
      image.src = backgroundUrl;
    } catch { return; }
  }, [backgroundUrl]);

  function point(event: React.PointerEvent<HTMLCanvasElement>) { const rect = event.currentTarget.getBoundingClientRect(); return canvasPoint(event.clientX, event.clientY, rect); }
  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    pointerRef.current = event.pointerId;
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* constrained WebView fallback */ }
    const next = [point(event)];
    currentRef.current = next;
    setCurrent(next);
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (pointerRef.current !== event.pointerId) return;
    event.preventDefault();
    setCurrent((value) => {
      const next = value.length >= 4096 ? value : [...value, point(event)];
      currentRef.current = next;
      return next;
    });
  }
  function end(event?: React.PointerEvent<HTMLCanvasElement>) {
    if (event && pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    const stroke = completedStroke(currentRef.current, color, size, eraser);
    if (stroke) setStrokes((value) => [...value, stroke]);
    setRedo([]);
    currentRef.current = [];
    setCurrent([]);
  }

  async function importImage(file: File | undefined) {
    if (!file) return;
    if (file.size > DRAW_IMPORT_MAX_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setMessage("Choose a JPEG, PNG, or WebP under 10 MB."); return; }
    const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === "string") { setBackgroundUrl(reader.result); setStrokes([]); setRedo([]); setMessage("Image imported. Add a prompt or draw over it."); } }; reader.readAsDataURL(file);
  }

  async function generate() {
    if (!authorized) { setMessage("Open this canvas from the iMessage conversation first."); return; }
    if (isDrawJobActive(job?.state)) { setMessage(drawJobLabel(job?.state)); return; }
    const strokeCanvas = strokeCanvasRef.current; const backgroundCanvas = backgroundCanvasRef.current;
    if (!strokeCanvas || !backgroundCanvas) return;
    const ink = hasVisibleInk(strokeCanvas.getContext("2d")?.getImageData(0, 0, DRAW_CANVAS_SIZE, DRAW_CANVAS_SIZE).data ?? new Uint8ClampedArray());
    if (!prompt.trim() && !ink && !backgroundUrl) { setMessage("Add a sketch, import an image, or write a prompt first."); return; }
    setMessage("Preparing…");
    const flattened = document.createElement("canvas"); flattened.width = DRAW_CANVAS_SIZE; flattened.height = DRAW_CANVAS_SIZE;
    const context = flattened.getContext("2d"); if (!context) return;
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, DRAW_CANVAS_SIZE, DRAW_CANVAS_SIZE); context.drawImage(backgroundCanvas, 0, 0); context.drawImage(strokeCanvas, 0, 0);
    let mediaId: string | undefined;
    if (ink || backgroundUrl) {
      const blob = await new Promise<Blob | null>((resolve) => flattened.toBlob(resolve, "image/png"));
      if (!blob) { setMessage("The sketch could not be prepared. Try again."); return; }
      const upload = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/media`, { method: "POST", headers: { "content-type": "image/png" }, body: blob });
      if (!upload.ok) { setMessage("The image could not be uploaded. Try again."); return; }
      mediaId = (await upload.json() as { mediaId: string }).mediaId;
    }
    const requestKey = requestKeyRef.current ?? crypto.randomUUID(); requestKeyRef.current = requestKey;
    const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/generations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey, prompt: prompt.trim(), ...(mediaId ? { mediaId } : {}), mode }) });
    if (!response.ok) { setMessage(response.status === 503 ? "COAST Draw is temporarily paused." : "That generation could not start. Try again."); return; }
    const body = await response.json() as { jobId: string; state: string };
    setJob({ id: body.jobId, state: body.state }); setMessage(drawJobLabel(body.state));
  }

  async function cancel() { if (!job?.id) return; const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST" }); if (response.ok) setMessage("Cancelled."); else setMessage("This request can no longer be cancelled."); }
  function refine() { if (!job?.outputUrl) return; setBackgroundUrl(job.outputUrl); setStrokes([]); setRedo([]); setJob(null); setTab("sketch"); setMessage("Result loaded. Add a prompt or draw a refinement."); }

  return <main className="draw-shell">
    <header className="draw-header"><div><p className="eyebrow">COAST DRAW</p><h1>Sketch a move</h1></div><span className="status" aria-live="polite">{drawJobLabel(job?.state)}</span></header>
    <div className="tabs" role="tablist"><button className={tab === "sketch" ? "active" : ""} onClick={() => setTab("sketch")}>Sketch</button><button className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")} disabled={!job?.previewUrl && !job?.outputUrl}>Preview</button></div>
    <section className="viewport"><canvas ref={backgroundCanvasRef} className={tab === "preview" && job?.previewUrl ? "hidden" : "layer"} aria-hidden="true" /><canvas ref={strokeCanvasRef} className={tab === "preview" && job?.previewUrl ? "hidden" : "layer"} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} aria-label="COAST drawing canvas" />{tab === "preview" && (job?.previewUrl || job?.outputUrl) ? <img className="preview-image" src={job.outputUrl ?? job.previewUrl} alt="COAST generated preview" /> : null}<span className="canvas-hint">1024 × 1024</span></section>
    <div className="toolbar" aria-label="Drawing tools"><div className="palette">{colors.map((value) => <button key={value} className="swatch" style={{ background: value }} aria-label={`Use ${value}`} onClick={() => { setColor(value); setEraser(false); }} />)}</div><label className="size">Size <input type="range" min="4" max="64" value={size} onChange={(event) => setSize(Number(event.target.value))} /></label><button className={eraser ? "selected" : ""} onClick={() => setEraser((value) => !value)}>Eraser</button><button onClick={() => { const value = strokes.at(-1); if (value) { setRedo((items) => [...items, value]); setStrokes((items) => items.slice(0, -1)); } }} disabled={!strokes.length}>Undo</button><button onClick={() => { const value = redo.at(-1); if (value) { setStrokes((items) => [...items, value]); setRedo((items) => items.slice(0, -1)); } }} disabled={!redo.length}>Redo</button><button onClick={() => { setStrokes([]); setRedo([]); }}>Clear</button><label className="import">Import<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void importImage(event.target.files?.[0])} /></label></div>
    <section className="bottom-sheet"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the image (optional)" aria-label="Prompt" /><div className="actions"><div className="mode-toggle" role="group" aria-label="Generation mode"><button className={mode === "fast" ? "active" : ""} onClick={() => setMode("fast")}>Fast</button><button className={mode === "detailed" ? "active" : ""} onClick={() => setMode("detailed")}>Detailed</button></div>{isDrawJobActive(job?.state) ? <button className="cancel" onClick={() => void cancel()}>Cancel</button> : <button className="generate" onClick={() => void generate()}>Generate</button>}</div><p className="message" aria-live="polite">{message}</p>{job?.outputUrl && job.state === "delivered" ? <button className="refine" onClick={refine}>Draw on this result</button> : null}</section>
    <style jsx>{`*{box-sizing:border-box}.draw-shell{min-height:100dvh;background:#13221b;color:#f8f1df;padding:max(10px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));font-family:ui-sans-serif,system-ui;display:flex;flex-direction:column;gap:8px}.draw-header{display:flex;justify-content:space-between;align-items:center;max-width:720px;width:100%;margin:0 auto}.eyebrow{color:#f4b544;letter-spacing:.16em;font-size:11px;font-weight:800;margin:0 0 2px}h1{font-size:22px;margin:0}.status{font-size:13px;color:#f4b544}.tabs{display:flex;gap:4px;max-width:720px;width:100%;margin:auto}.tabs button,.mode-toggle button{background:transparent;color:#d8d1be;border:0;padding:10px 14px;min-height:44px;border-radius:12px;font-weight:700}.tabs button.active,.mode-toggle button.active{background:#344a3b;color:#fff}.tabs button:disabled{opacity:.35}.viewport{position:relative;width:min(100%,720px);aspect-ratio:1;margin:auto;background:#fff;border-radius:14px;overflow:hidden;touch-action:none;box-shadow:0 8px 30px #0003}.layer,.preview-image{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.layer{touch-action:none}.hidden{visibility:hidden}.preview-image{z-index:3}.canvas-hint{position:absolute;right:10px;bottom:8px;color:#777;background:#fff9;border-radius:8px;padding:3px 6px;font-size:10px;z-index:4}.toolbar{display:flex;align-items:center;gap:6px;max-width:720px;width:100%;margin:auto;overflow-x:auto;padding:2px 0}.toolbar button,.import{border:0;background:#344a3b;color:#f8f1df;border-radius:10px;min-height:44px;padding:8px 11px;white-space:nowrap;font-weight:650}.toolbar button:disabled{opacity:.35}.toolbar .selected{outline:2px solid #f4b544}.palette{display:flex;gap:5px}.swatch{width:32px!important;padding:0!important;border:2px solid #f8f1df!important;border-radius:50%!important}.size{display:flex;align-items:center;gap:4px;color:#f5d998;font-size:12px;white-space:nowrap}.size input{width:72px}.import{position:relative;cursor:pointer}.import input{position:absolute;inset:0;opacity:0;width:100%;height:100%}.bottom-sheet{max-width:720px;width:100%;margin:auto;background:#1d3025;border:1px solid #3d5548;border-radius:16px;padding:8px}.bottom-sheet textarea{width:100%;min-height:52px;max-height:110px;resize:vertical;border:1px solid #526357;background:#25352b;color:#fff;border-radius:10px;padding:10px;font:inherit}.actions{display:flex;gap:8px;margin-top:8px}.mode-toggle{display:flex;background:#13221b;border-radius:12px}.generate,.cancel{flex:1;border:0;border-radius:11px;min-height:44px;font-size:16px;font-weight:800}.generate{background:#f4b544;color:#13221b}.cancel{background:#7e4638;color:#fff}.message{font-size:12px;color:#d8d1be;margin:7px 2px 0;min-height:16px}.refine{width:100%;border:0;background:#f4b544;color:#13221b;border-radius:10px;min-height:42px;font-weight:800}@media(min-width:760px){.draw-shell{padding:18px}.toolbar{justify-content:center}.bottom-sheet{padding:12px}}`}</style>
  </main>;
}
