"use client";
/* eslint-disable @next/next/no-img-element */

import dynamic from "next/dynamic";
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
import { ToolcraftButton } from "./toolcraft-controls";
import type { RasterEditorAdapter } from "./tldraw-adapter";

const GhostFibers = dynamic(() => import("./ghost-fibers"), { ssr: false });
const GlowCursor = dynamic(() => import("./glow-cursor"), { ssr: false });

const TldrawAdapter = dynamic(() => import("./tldraw-adapter"), { ssr: false });

type Props = { sessionId: string; tldrawEnabled?: boolean; tldrawLicenseKey?: string };
type Job = { id: string; state: string; outputUrl?: string; previewUrl?: string; errorCode?: string | null } | null;
type EventItem = { jobId: string; sequence: number; kind: string; state: string; mediaId: string | null; previewIndex: number | null; errorCode: string | null };
type JobSnapshot = { jobId: string; state: string; previewMediaId: string | null; outputMediaId: string | null; errorCode: string | null } | null;
type Revision = { jobId: string; parentJobId: string | null; rootJobId: string | null; revisionNumber: number; mode: DrawMode | null; model: string | null; state: string; outputMediaId: string | null; previewMediaId: string | null; createdAtMs: number };
type DrawView = "sketch" | "preview";

const colors = ["#17231d", "#b45309", "#dc2626", "#2563eb", "#ffffff"];
const mediaUrl = (sessionId: string, mediaId: string) => `/api/draw/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(mediaId)}`;
const modeLabels: Record<DrawMode, string> = { fast: "Flare Fast", detailed: "Flare Detailed", turbo: "Turbo · 4 steps", hq: "Sunburst HQ" };

function ModeIcon({ mode }: { mode: DrawMode }) {
  if (mode === "fast") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-8 12h6l-1 8 8-12h-6l1-8Z" /></svg>;
  if (mode === "detailed") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16M8 4v4M15 10v4M11 16v4" /></svg>;
  if (mode === "turbo") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-2 7H5l5 4-2 9 8-10h-5l2-10ZM18 3v4M20 5h-4" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 2.1 6.3L20 11l-5.9 2.7L12 20l-2.1-6.3L4 11l5.9-2.7L12 2ZM19 17v5M21.5 19.5h-5" /></svg>;
}

export default function DrawStudio({ sessionId, tldrawEnabled = false, tldrawLicenseKey }: Props) {
  const strokeCanvasRef = useRef<HTMLCanvasElement>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingSurfaceRef = useRef<HTMLElement>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);
  const touchDrawingRef = useRef(false);
  const currentRef = useRef<DrawPoint[]>([]);
  const glowPointRef = useRef<DrawPoint | null>(null);
  const glowActiveRef = useRef(false);
  const viewTouchedRef = useRef(false);
  const lastSequenceRef = useRef(0);
  const requestKeyRef = useRef<string | null>(null);
  const selectedRevisionRef = useRef<string | null>(typeof window === "undefined" ? null : window.sessionStorage.getItem(`coast-draw-revision:${sessionId}`));
  const preparingRef = useRef(false);
  const savingRef = useRef(false);
  const tldrawAdapterRef = useRef<RasterEditorAdapter | null>(null);
  const [strokes, setStrokes] = useState<DrawStroke[]>([]);
  const [redo, setRedo] = useState<DrawStroke[]>([]);
  const [current, setCurrent] = useState<DrawPoint[]>([]);
  const [color, setColor] = useState(colors[0]!);
  const [size, setSize] = useState(18);
  const [eraser, setEraser] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<DrawMode>("fast");
  const [job, setJob] = useState<Job>(null);
  const [tab, setTab] = useState<DrawView>("sketch");
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("Add a sketch or prompt, then tap Generate.");
  const [authorized, setAuthorized] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [backgroundKind, setBackgroundKind] = useState<"photo" | "result" | null>(null);
  const [animating, setAnimating] = useState(false);
  const [useTldraw, setUseTldraw] = useState(tldrawEnabled && Boolean(tldrawLicenseKey));
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(() => typeof window === "undefined" ? null : window.sessionStorage.getItem(`coast-draw-revision:${sessionId}`));
  const [refining, setRefining] = useState(false);
  const [resetContext, setResetContext] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [promptFocused, setPromptFocused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [decodedPreview, setDecodedPreview] = useState<{ key: string; url: string } | null>(null);

  const selectView = useCallback((next: DrawView, explicit = true) => {
    if (explicit) viewTouchedRef.current = true;
    setTab(next);
  }, []);

  const applyJob = useCallback((next: { id: string; state: string; previewMediaId?: string | null; outputMediaId?: string | null; errorCode?: string | null }) => {
    setJob((previous) => {
      const isNew = previous?.id !== next.id;
      return {
        id: next.id,
        state: next.state,
        ...(isNew ? {} : previous?.previewUrl ? { previewUrl: previous.previewUrl } : {}),
        ...(isNew ? {} : previous?.outputUrl ? { outputUrl: previous.outputUrl } : {}),
        ...(next.previewMediaId ? { previewUrl: mediaUrl(sessionId, next.previewMediaId) } : {}),
        ...(next.outputMediaId ? { outputUrl: mediaUrl(sessionId, next.outputMediaId) } : {}),
        ...(next.errorCode ? { errorCode: next.errorCode } : {}),
      };
    });
  }, [sessionId]);

  useEffect(() => {
    if (selectedRevisionId) window.sessionStorage.setItem(`coast-draw-revision:${sessionId}`, selectedRevisionId);
  }, [selectedRevisionId, sessionId]);

  const applyEvent = useCallback((event: EventItem) => {
    if (event.sequence <= lastSequenceRef.current) return;
    lastSequenceRef.current = event.sequence;
    // A user reviewing an older branch owns their canvas. A background event
    // may refresh data but cannot pull them into another revision.
    if (selectedRevisionRef.current && selectedRevisionRef.current !== event.jobId) return;
    applyJob({
      id: event.jobId,
      state: event.state,
      ...(event.kind === "preview" && event.mediaId ? { previewMediaId: event.mediaId } : {}),
      ...(event.kind === "completed" && event.mediaId ? { outputMediaId: event.mediaId } : {}),
      errorCode: event.errorCode,
    });
    if (event.kind === "preview" && event.mediaId && !viewTouchedRef.current) selectView("preview", false);
    if (event.kind === "completed" && event.mediaId) {
      if (!viewTouchedRef.current) selectView("preview", false);
      setMessage("Image ready. Review it, animate it, or tap Save to send it in iMessage.");
    } else if (event.errorCode) {
      setMessage("This request needs attention. You can start a new image when it clears.");
    } else {
      setMessage(drawJobLabel(event.state));
    }
    if (["delivered", "failed", "terminal_failure", "refused", "cancelled", "expired"].includes(event.state)) requestKeyRef.current = null;
  }, [applyJob, selectView, setMessage]);

  const applySnapshot = useCallback((snapshot: JobSnapshot) => {
    if (!snapshot) return;
    if (selectedRevisionRef.current && selectedRevisionRef.current !== snapshot.jobId) return;
    applyJob({ id: snapshot.jobId, state: snapshot.state, previewMediaId: snapshot.previewMediaId, outputMediaId: snapshot.outputMediaId, errorCode: snapshot.errorCode });
    if (snapshot.outputMediaId && !viewTouchedRef.current) {
      selectView("preview", false);
      setMessage(snapshot.state === "ready_for_save" ? "Image ready. Review it, animate it, or tap Save to send it in iMessage." : drawJobLabel(snapshot.state));
    }
  }, [applyJob, selectView, setMessage]);

  const refreshRevisions = useCallback(async () => {
    const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/revisions`, { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json() as { revisions?: Revision[] };
    const nextRevisions = body.revisions ?? [];
    setRevisions(nextRevisions);
    const restored = selectedRevisionRef.current && nextRevisions.find((item) => item.jobId === selectedRevisionRef.current);
    if (restored) {
      applyJob({ id: restored.jobId, state: restored.state, previewMediaId: restored.previewMediaId, outputMediaId: restored.outputMediaId });
      if (restored.outputMediaId && !viewTouchedRef.current) selectView("preview", false);
    }
  }, [applyJob, selectView, sessionId]);

  const refreshStatus = useCallback(async () => {
    const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/status?after=${lastSequenceRef.current}`, { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json() as { events?: EventItem[]; currentJob?: JobSnapshot };
    for (const event of body.events ?? []) applyEvent(event);
    applySnapshot(body.currentJob ?? null);
    void refreshRevisions();
  }, [applyEvent, applySnapshot, refreshRevisions, sessionId]);

  useEffect(() => {
    const secret = drawLaunchSecret(window.location.hash);
    const endpoint = `/api/draw/sessions/${encodeURIComponent(sessionId)}`;
    const request = fetch(`${endpoint}/status`, { cache: "no-store" }).then((response) => {
      if (response.ok || !secret) return response;
      return fetch(`${endpoint}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) });
    });
    void request.then((response) => {
      if (!response.ok) { setMessage(secret ? "This drawing link expired. Send /draw for a fresh link." : "Open this canvas from its iMessage link."); return; }
      setAuthorized(true);
      if (secret) { try { history.replaceState(null, "", `/draw/${encodeURIComponent(sessionId)}`); } catch { /* Photon webview fallback */ } }
      void refreshStatus();
    }).catch(() => setMessage("COAST Draw could not connect. Try reopening the link."));
  }, [refreshStatus, sessionId]);

  useEffect(() => {
    if (!authorized) return;
    const source = new EventSource(`/api/draw/sessions/${encodeURIComponent(sessionId)}/events?after=${lastSequenceRef.current}`);
    const handle = (event: MessageEvent<string>) => { try { applyEvent(JSON.parse(event.data) as EventItem); } catch { /* keep SSE alive */ } };
    const handleError = (event: MessageEvent<string>) => { try { const error = JSON.parse(event.data) as { code?: string }; setMessage(error.code === "session_expired" ? "This drawing link expired. Send /draw for a fresh link." : "Live updates paused. Reconnecting…"); } catch { /* EventSource reconnects itself */ } };
    source.addEventListener("state", handle); source.addEventListener("preview", handle); source.addEventListener("completed", handle); source.addEventListener("error", handleError);
    const poll = window.setInterval(() => void refreshStatus(), 2_000);
    return () => { source.close(); window.clearInterval(poll); };
  }, [applyEvent, authorized, refreshStatus, sessionId]);

  // Messages WebViews sometimes ignore touch-action during a sheet gesture.
  // This narrowly-scoped non-passive fallback only owns a gesture that began
  // on the drawing surface, so toolbar and prompt controls still scroll.
  useEffect(() => {
    const node = drawingSurfaceRef.current;
    if (!node) return;
    const startTouch = (event: TouchEvent) => {
      if (node.contains(event.target as Node)) {
        touchDrawingRef.current = true;
        event.preventDefault();
      }
    };
    const stop = (event: TouchEvent) => {
      if (touchDrawingRef.current && node.contains(event.target as Node)) event.preventDefault();
    };
    const endTouch = () => { touchDrawingRef.current = false; };
    node.addEventListener("touchstart", startTouch, { passive: false });
    node.addEventListener("touchmove", stop, { passive: false });
    node.addEventListener("touchend", endTouch, { passive: true });
    node.addEventListener("touchcancel", endTouch, { passive: true });
    return () => {
      node.removeEventListener("touchstart", startTouch);
      node.removeEventListener("touchmove", stop);
      node.removeEventListener("touchend", endTouch);
      node.removeEventListener("touchcancel", endTouch);
    };
  }, []);

  useEffect(() => {
    const update = () => document.documentElement.style.setProperty("--coast-draw-vvh", `${window.visualViewport?.height ?? window.innerHeight}px`);
    update();
    window.visualViewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => { window.visualViewport?.removeEventListener("resize", update); window.removeEventListener("resize", update); };
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // The mini-app has a fixed viewport, so a zero-sized drawing surface is a
  // layout regression rather than an empty canvas. Keep this developer-only
  // signal out of the user experience while making a future collapse obvious.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const viewport = canvasViewportRef.current;
    if (!viewport) return;
    let warned = false;
    const inspect = () => {
      const collapsed = viewport.clientWidth === 0 || viewport.clientHeight === 0;
      if (collapsed && !warned) console.warn("[COAST Draw] canvas viewport collapsed; verify the Draw shell layout.");
      warned = collapsed;
    };
    inspect();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(inspect);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [revisions.length, useTldraw]);

  useEffect(() => {
    const canvas = strokeCanvasRef.current;
    if (!canvas) return;
    canvas.width = DRAW_CANVAS_SIZE; canvas.height = DRAW_CANVAS_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, DRAW_CANVAS_SIZE, DRAW_CANVAS_SIZE);
    for (const stroke of strokes) paintStroke(context, stroke);
    if (current.length > 1) paintStroke(context, { points: current, color, width: size, erase: eraser });
  }, [color, current, eraser, size, strokes]);

  useEffect(() => {
    const canvas = backgroundCanvasRef.current;
    if (!canvas) return;
    canvas.width = DRAW_CANVAS_SIZE; canvas.height = DRAW_CANVAS_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#fff"; context.fillRect(0, 0, DRAW_CANVAS_SIZE, DRAW_CANVAS_SIZE);
    if (!backgroundUrl) return;
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
      const fit = containImage(image.naturalWidth, image.naturalHeight);
      context.drawImage(image, fit.x, fit.y, fit.width, fit.height);
    };
    image.onerror = () => setMessage("The selected image could not be displayed. Try another image.");
    image.src = backgroundUrl;
  }, [backgroundUrl]);

  function point(event: React.PointerEvent<HTMLCanvasElement>) { const rect = event.currentTarget.getBoundingClientRect(); return canvasPoint(event.clientX, event.clientY, rect); }
  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (tab !== "sketch") return;
    event.preventDefault(); event.stopPropagation?.(); pointerRef.current = event.pointerId;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* constrained Photon fallback */ }
    const nextPoint = point(event);
    const next = [nextPoint]; currentRef.current = next; setCurrent(next); setDrawing(true);
    glowPointRef.current = nextPoint; glowActiveRef.current = !eraser;
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (pointerRef.current !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation?.();
    const next = currentRef.current.length >= 4096 ? currentRef.current : [...currentRef.current, point(event)];
    currentRef.current = next; setCurrent(next); glowPointRef.current = next.at(-1) ?? null;
  }
  function end(event?: React.PointerEvent<HTMLCanvasElement>) {
    if (event && pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    const stroke = completedStroke(currentRef.current, color, size, eraser);
    if (stroke) setStrokes((value) => [...value, stroke]);
    setRedo([]); currentRef.current = []; setCurrent([]); setDrawing(false); glowActiveRef.current = false; glowPointRef.current = null;
  }

  async function importImage(file: File | undefined) {
    if (!file) return;
    if (file.size > DRAW_IMPORT_MAX_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setMessage("Choose a JPEG, PNG, or WebP under 10 MB."); return; }
    if (useTldraw) setUseTldraw(false);
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string") { setBackgroundUrl(reader.result); setBackgroundKind("photo"); setStrokes([]); setRedo([]); selectView("sketch"); setMessage("Image imported. Add a prompt or draw over it."); } };
    reader.readAsDataURL(file);
  }

  async function generate() {
    if (preparingRef.current || !authorized || isDrawJobActive(job?.state)) return;
    const strokeCanvas = strokeCanvasRef.current; const backgroundCanvas = backgroundCanvasRef.current;
    if (!useTldraw && (!strokeCanvas || !backgroundCanvas)) return;
    let tldrawBlob: Blob | null = null;
    const ink = useTldraw
      ? Boolean(tldrawBlob = await tldrawAdapterRef.current?.exportJpeg() ?? null)
      : hasVisibleInk(strokeCanvas?.getContext("2d")?.getImageData(0, 0, DRAW_CANVAS_SIZE, DRAW_CANVAS_SIZE).data ?? new Uint8ClampedArray());
    if (!prompt.trim() && !ink && !backgroundUrl) { setMessage("Add a sketch, import an image, or write a prompt first."); return; }
    preparingRef.current = true; setPreparing(true); setMessage("Preparing…");
    try {
      const flattened = document.createElement("canvas"); flattened.width = DRAW_CANVAS_SIZE; flattened.height = DRAW_CANVAS_SIZE;
      const context = flattened.getContext("2d"); if (!context) throw new Error("canvas_unavailable");
      context.fillStyle = "#fff"; context.fillRect(0, 0, DRAW_CANVAS_SIZE, DRAW_CANVAS_SIZE);
      if (!useTldraw && backgroundCanvas && strokeCanvas) { context.drawImage(backgroundCanvas, 0, 0); context.drawImage(strokeCanvas, 0, 0); }
      const parentJobId = backgroundKind === "result" ? selectedRevisionId : null;
      // A text follow-up can reference its selected private result directly.
      // Only a new overlay/background needs a browser raster upload.
      const reuseParentArtifact = Boolean(parentJobId && !ink);
      let mediaId: string | undefined;
      if ((ink || backgroundUrl) && !reuseParentArtifact) {
        const blob = tldrawBlob ?? await new Promise<Blob | null>((resolve) => flattened.toBlob(resolve, "image/jpeg", 0.9));
        if (!blob) throw new Error("canvas_encode_failed");
        const upload = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/media`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
        if (!upload.ok) throw new Error("upload_failed");
        mediaId = (await upload.json() as { mediaId: string }).mediaId;
      }
      const requestKey = requestKeyRef.current ?? crypto.randomUUID(); requestKeyRef.current = requestKey;
      const category = ink ? "sketch" : backgroundKind ?? "prompt";
      const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/generations`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestKey, prompt: prompt.trim(), ...(mediaId ? { mediaId } : {}), ...(parentJobId ? { parentJobId } : {}), ...(resetContext ? { resetContext: true } : {}), mode, ...(mediaId ? { inputCategory: category } : {}) }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string };
        setMessage(response.status === 401 ? "This session expired. Send /draw for a fresh link." : failure.error?.includes("CREATIVE_JOB_ALREADY_ACTIVE") ? "Another image is still generating." : failure.error?.includes("awaiting_payment") ? "Add credit in iMessage, then try again." : failure.error?.includes("DRAW_CONTEXT_TOO_LONG") ? "This edit history is full. Turn on Start fresh from this image, then Generate." : "That generation could not start. Try again.");
        return;
      }
      const body = await response.json() as { jobId: string; state: string };
      viewTouchedRef.current = false;
      selectedRevisionRef.current = body.jobId; setSelectedRevisionId(body.jobId); setRefining(false); setResetContext(false);
      applyJob({ id: body.jobId, state: body.state }); setMessage(drawJobLabel(body.state));
    } catch { setMessage("Couldn’t prepare this image. Tap Generate to retry safely."); }
    finally { preparingRef.current = false; setPreparing(false); }
  }

  async function cancel() {
    if (!job?.id) return;
    const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST" });
    setMessage(response.ok ? "Cancelled." : "This request can no longer be cancelled.");
  }
  async function save() {
    if (!job?.id || job.state !== "ready_for_save" || savingRef.current) return;
    savingRef.current = true; setSaving(true); setMessage("Sending to iMessage…");
    try {
      const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(job.id)}/save`, { method: "POST" });
      if (!response.ok) { setMessage(response.status === 401 ? "This session expired. Send /draw for a fresh link." : "The image is safe here. Tap Save to retry."); return; }
      const body = await response.json() as { state: string };
      setJob((currentJob) => currentJob ? { ...currentJob, state: body.state } : currentJob); setMessage(body.state === "delivered" ? "Delivered to iMessage." : "Sending to iMessage…");
    } catch { setMessage("The image is safe here. Tap Save to retry."); }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function animate() {
    if (!job?.id || !job.outputUrl || animating) return;
    setAnimating(true); setMessage("Starting a 15-second video…");
    try {
      const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(job.id)}/animate`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: crypto.randomUUID() }),
      });
      if (!response.ok) { setMessage("The image is ready, but that video could not start."); return; }
      const body = await response.json() as { state: string };
      setMessage(body.state === "awaiting_payment" ? "Add credit in iMessage to animate this image." : "Video queued. COAST will send it in iMessage when it’s ready.");
    } catch { setMessage("The image is ready, but that video could not start."); }
    finally { setAnimating(false); }
  }
  function refine() {
    if (!job?.outputUrl) return;
    setUseTldraw(false); setBackgroundUrl(job.outputUrl); setBackgroundKind("result"); setStrokes([]); setRedo([]); setCurrent([]); requestKeyRef.current = null;
    selectedRevisionRef.current = job.id; setSelectedRevisionId(job.id); setRefining(true); setResetContext(false); selectView("sketch"); setMessage("Result loaded. Add a follow-up instruction or draw a refinement.");
  }

  function selectRevision(revision: Revision) {
    selectedRevisionRef.current = revision.jobId; setSelectedRevisionId(revision.jobId); setRefining(false); setResetContext(false);
    applyJob({ id: revision.jobId, state: revision.state, ...(revision.previewMediaId ? { previewMediaId: revision.previewMediaId } : {}), ...(revision.outputMediaId ? { outputMediaId: revision.outputMediaId } : {}) });
    if (revision.outputMediaId || revision.previewMediaId) selectView("preview");
  }

  const ready = !refining && Boolean(job?.outputUrl) && ["ready_for_save", "ready_for_delivery", "delivered"].includes(job?.state ?? "");
  const currentPreviewUrl = job?.outputUrl ?? job?.previewUrl ?? null;
  const currentPreviewKey = job && currentPreviewUrl ? `${job.id}:${currentPreviewUrl}` : null;
  useEffect(() => {
    if (!currentPreviewUrl || !currentPreviewKey || decodedPreview?.key === currentPreviewKey) return;
    const image = new Image();
    image.onload = () => setDecodedPreview({ key: currentPreviewKey, url: currentPreviewUrl });
    image.onerror = () => setMessage("The image is ready, but its preview could not load. Reopen the card and try again.");
    image.src = currentPreviewUrl;
  }, [currentPreviewKey, currentPreviewUrl, decodedPreview?.key]);
  const showingGeneratedImage = tab === "preview" && Boolean(decodedPreview);
  const sketchEditable = tab === "sketch" && !preparing && !isDrawJobActive(job?.state);

  return <main className="draw-shell">
    <div className="effects-backdrop"><GhostFibers paused={drawing || promptFocused || preparing || isDrawJobActive(job?.state)} reducedMotion={reducedMotion} /></div>
    <div className="draw-top-controls">
      <header className="draw-header"><div><p className="eyebrow">COAST DRAW</p><h1>Sketch a move</h1></div></header>
      <nav className="view-toggle" data-view={tab} role="tablist" aria-label="Canvas view"><span className="view-toggle-thumb" aria-hidden="true" /><ToolcraftButton className={tab === "sketch" ? "active" : ""} role="tab" aria-selected={tab === "sketch"} onClick={() => selectView("sketch")}>Sketch</ToolcraftButton><ToolcraftButton className={tab === "preview" ? "active" : ""} role="tab" aria-selected={tab === "preview"} onClick={() => selectView("preview")} disabled={!decodedPreview}>Preview</ToolcraftButton></nav>
      {revisions.length > 0 ? <nav className="revision-strip" aria-label="Image revisions">{revisions.map((revision) => <ToolcraftButton key={revision.jobId} className={selectedRevisionId === revision.jobId ? "selected" : ""} onClick={() => selectRevision(revision)}>{revision.outputMediaId || revision.previewMediaId ? <img src={mediaUrl(sessionId, revision.outputMediaId ?? revision.previewMediaId!)} alt="" draggable={false} /> : null}<span>R{revision.revisionNumber}</span><small>{revision.mode ? modeLabels[revision.mode] : "Image"}</small><em>{revision.state === "ready_for_save" ? "Ready" : drawJobLabel(revision.state)}</em></ToolcraftButton>)}</nav> : null}
      <div className="toolbar" aria-label="Drawing tools"><div className="palette">{colors.map((value) => <ToolcraftButton key={value} className={`swatch ${color === value && !eraser ? "selected" : ""}`} style={{ background: value }} aria-label={`Use ${value}`} disabled={!sketchEditable} onClick={() => { setColor(value); setEraser(false); tldrawAdapterRef.current?.setBrush(value, size); }} />)}</div><label className="size">Size <input type="range" min="4" max="64" value={size} disabled={!sketchEditable} aria-label="Brush size" onChange={(event) => { const next = Number(event.target.value); setSize(next); tldrawAdapterRef.current?.setBrush(color, next); }} /></label><ToolcraftButton className={eraser ? "selected" : ""} disabled={!sketchEditable} onClick={() => setEraser((value) => { const next = !value; tldrawAdapterRef.current?.setEraser(next); return next; })}>Eraser</ToolcraftButton><ToolcraftButton disabled={!sketchEditable || (!useTldraw && !strokes.length)} onClick={() => { if (useTldraw) tldrawAdapterRef.current?.undo(); else { const stroke = strokes.at(-1); if (stroke) { setRedo((items) => [...items, stroke]); setStrokes((items) => items.slice(0, -1)); } } }}>Undo</ToolcraftButton><ToolcraftButton disabled={!sketchEditable || (!useTldraw && !redo.length)} onClick={() => { if (useTldraw) tldrawAdapterRef.current?.redo(); else { const stroke = redo.at(-1); if (stroke) { setStrokes((items) => [...items, stroke]); setRedo((items) => items.slice(0, -1)); } } }}>Redo</ToolcraftButton><ToolcraftButton disabled={!sketchEditable} onClick={() => { if (useTldraw) tldrawAdapterRef.current?.clear(); else { setStrokes([]); setRedo([]); } }}>Clear</ToolcraftButton><label className={`import ${!sketchEditable ? "disabled" : ""}`}>Import<input type="file" accept="image/jpeg,image/png,image/webp" disabled={!sketchEditable} onChange={(event) => void importImage(event.target.files?.[0])} /></label></div>
    </div>
    <section className="canvas-zone" ref={drawingSurfaceRef}><div ref={canvasViewportRef} className="viewport" data-testid="draw-canvas-viewport"><div className={`sketch-layers ${showingGeneratedImage ? "is-faded" : ""}`} aria-hidden="true">{useTldraw && tldrawLicenseKey ? <TldrawAdapter licenseKey={tldrawLicenseKey} onReady={(adapter) => { tldrawAdapterRef.current = adapter; adapter.setBrush(color, size); }} /> : <><canvas ref={backgroundCanvasRef} className="layer" /><canvas ref={strokeCanvasRef} className="layer" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onContextMenu={(event) => event.preventDefault()} aria-label="COAST drawing canvas" data-testid="draw-canvas" /></>}</div>{currentPreviewUrl ? <img className={`preview-image ${showingGeneratedImage ? "is-visible" : "is-hidden"}`} src={decodedPreview?.url ?? currentPreviewUrl} alt="COAST generated preview" draggable={false} /> : null}{currentPreviewUrl && decodedPreview?.url !== currentPreviewUrl ? <img className="preview-preload" src={currentPreviewUrl} alt="" aria-hidden="true" draggable={false} onLoad={() => setDecodedPreview({ key: currentPreviewKey ?? "", url: currentPreviewUrl })} onError={() => setMessage("The image is ready, but its preview could not load. Reopen the card and try again.")} /> : null}<GlowCursor activeRef={glowActiveRef} pointRef={glowPointRef} className="pencil-glow" /><span className="canvas-hint">1024 × 1024</span></div></section>
    <section className="bottom-sheet"><textarea value={prompt} onFocus={() => setPromptFocused(true)} onBlur={() => setPromptFocused(false)} onChange={(event) => setPrompt(event.target.value)} placeholder={refining ? "Follow-up instruction, e.g. Make the sky sunset" : "Describe the image (optional)"} aria-label="Prompt" /><div className="mode-picker" role="radiogroup" aria-label="Generation mode">{(["fast", "detailed", "turbo", "hq"] as DrawMode[]).map((item) => <ToolcraftButton key={item} data-mode={item} className={mode === item ? "active" : ""} role="radio" aria-checked={mode === item} aria-label={modeLabels[item]} onClick={() => setMode(item)} onKeyDown={(event) => { if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return; event.preventDefault(); const modes: DrawMode[] = ["fast", "detailed", "turbo", "hq"]; const index = modes.indexOf(item); const next = modes[(index + (event.key === "ArrowRight" ? 1 : -1) + modes.length) % modes.length]!; setMode(next); (event.currentTarget.parentElement?.querySelector(`[data-mode="${next}"]`) as HTMLButtonElement | null)?.focus(); }}><ModeIcon mode={item} /></ToolcraftButton>)}</div><div className="model-caption" aria-live="polite">{modeLabels[mode]}</div>{refining ? <button className={`context-reset ${resetContext ? "selected" : ""}`} onClick={() => setResetContext((value) => !value)}>{resetContext ? "Starting fresh from this image" : "Start fresh from this image"}</button> : null}<div className="actions">{ready ? <><button className="discard" onClick={() => void cancel()}>Discard</button><button className="secondary" disabled={animating} onClick={() => void animate()}>{animating ? "Starting…" : "Animate"}</button><button className="save" disabled={saving || job?.state !== "ready_for_save"} onClick={() => void save()}>{saving ? "Saving…" : "Save to iMessage"}</button></> : isDrawJobActive(job?.state) ? <button className="cancel" onClick={() => void cancel()}>Cancel</button> : <button className="generate" disabled={preparing || !authorized || tab === "preview"} onClick={() => void generate()}>{preparing ? "Preparing…" : "Generate"}</button>}</div><p className="message" aria-live="polite">{message}</p>{ready ? <button className="refine" onClick={refine}>Draw on this result</button> : null}</section>
    <style jsx>{`
      :global(html),:global(body){height:100%;margin:0;overscroll-behavior:none;background:#13221b}
      *{box-sizing:border-box}.draw-shell{height:var(--coast-draw-vvh,100dvh);overflow:hidden;overscroll-behavior:none;background:#13221b;color:#f8f1df;padding:max(8px,env(safe-area-inset-top)) max(10px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left));font-family:ui-sans-serif,system-ui;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:7px}.draw-top-controls{display:grid;gap:7px;min-width:0}.draw-header,.tabs,.toolbar,.bottom-sheet,.revision-strip{width:min(100%,720px);margin:0 auto}.draw-header{display:flex;justify-content:space-between;align-items:center}.eyebrow{color:#f4b544;letter-spacing:.16em;font-size:10px;font-weight:850;margin:0 0 2px}h1{font-size:22px;line-height:1.05;margin:0}.status{font-size:12px;color:#f4b544;text-align:right}.tabs{display:flex;gap:4px}.tabs button,.mode-toggle button{background:transparent;color:#d8d1be;border:0;padding:9px 13px;min-height:44px;border-radius:12px;font-weight:750}.tabs button.active,.mode-toggle button.active{background:#344a3b;color:#fff}.tabs button:disabled{opacity:.35}.revision-strip{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}.revision-strip button{display:grid;gap:1px;min-width:76px;min-height:48px;padding:6px 9px;text-align:left;color:#f8f1df;border:1px solid #526357;border-radius:10px;background:#1d3025}.revision-strip button.selected{border-color:#f4b544;background:#344a3b}.revision-strip img{width:44px;height:28px;object-fit:cover;border-radius:5px;pointer-events:none}.revision-strip small,.revision-strip em{font-size:9px;font-style:normal;color:#d8d1be;white-space:nowrap}.revision-strip em{color:#f4b544}.toolbar{display:flex;align-items:center;gap:6px;overflow-x:auto;scrollbar-width:none;padding:1px 0}.toolbar button,.import{border:0;background:#344a3b;color:#f8f1df;border-radius:10px;min-height:44px;padding:8px 11px;white-space:nowrap;font-weight:700}.toolbar button:disabled{opacity:.35}.toolbar .selected{outline:2px solid #f4b544}.palette{display:flex;gap:5px}.swatch{width:34px!important;padding:0!important;border:2px solid #f8f1df!important;border-radius:50%!important;flex:0 0 34px}.size{display:flex;align-items:center;gap:4px;color:#f5d998;font-size:12px;white-space:nowrap}.size input{width:72px}.import{position:relative;cursor:pointer}.import input{position:absolute;inset:0;opacity:0;width:100%;height:100%}.canvas-zone{min-height:0;display:grid;place-items:center;overscroll-behavior:contain;touch-action:none}.viewport{position:relative;max-width:100%;max-height:100%;height:min(100%,720px);aspect-ratio:1;background:#fff;border-radius:14px;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;box-shadow:0 8px 30px #0003}.layer,.preview-image{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;touch-action:none;user-select:none;-webkit-user-drag:none}.tldraw-stage{position:absolute;inset:0}.hidden{visibility:hidden}.preview-image{z-index:3}.canvas-hint{position:absolute;right:9px;bottom:7px;color:#777;background:#fff9;border-radius:7px;padding:3px 6px;font-size:10px;z-index:4}.bottom-sheet{max-height:min(34dvh,250px);overflow:auto;background:#1d3025;border:1px solid #3d5548;border-radius:16px;padding:8px;overscroll-behavior:contain}.bottom-sheet textarea{width:100%;min-height:48px;max-height:96px;resize:vertical;border:1px solid #526357;background:#25352b;color:#fff;border-radius:10px;padding:9px;font:inherit}.mode-toggle{display:flex;background:#13221b;border-radius:12px;overflow-x:auto;margin-top:7px}.mode-toggle button{white-space:nowrap;flex:1;font-size:12px;padding-inline:9px}.context-reset{width:100%;border:1px solid #526357;border-radius:9px;background:#13221b;color:#f8f1df;min-height:34px;margin-top:7px;font-weight:700}.context-reset.selected{border-color:#f4b544;color:#f4b544}.actions{display:flex;gap:6px;margin-top:7px}.generate,.cancel,.save,.discard,.secondary{border:0;border-radius:11px;min-height:44px;font-size:14px;font-weight:850}.generate,.save{background:#f4b544;color:#13221b;flex:1}.cancel,.discard{background:#7e4638;color:#fff;padding:0 13px}.secondary{background:#344a3b;color:#f8f1df;padding:0 12px}.save:disabled{opacity:.55}.message{font-size:12px;color:#d8d1be;margin:6px 2px 0;min-height:15px}.refine{width:100%;border:0;background:#f4b544;color:#13221b;border-radius:10px;min-height:40px;font-weight:850;margin-top:6px}@media(max-height:680px){.draw-shell{gap:4px}.draw-top-controls{gap:4px}.toolbar button,.import{min-height:40px}.bottom-sheet{max-height:205px}.bottom-sheet textarea{min-height:40px}.mode-toggle button{min-height:38px}.draw-header h1{font-size:19px}}@media(min-width:760px){.draw-shell{padding:16px}.toolbar{justify-content:center}.bottom-sheet{padding:12px;max-height:270px}}`}</style>
    <style jsx>{`
      .draw-shell{position:relative;isolation:isolate;background:transparent}
      .effects-backdrop{position:absolute;inset:0;z-index:0;pointer-events:none;background:radial-gradient(circle at 50% 20%,#274332 0%,#13221b 58%,#0d1712 100%)}
      .ghost-fibers{position:absolute;inset:0;opacity:.72}
      .draw-top-controls,.canvas-zone,.bottom-sheet{position:relative;z-index:1}
      .view-toggle{position:relative;display:flex;justify-content:center;gap:2px;padding:3px;background:#122118d9;border:1px solid #526357;border-radius:14px;overflow:hidden}
      .view-toggle-thumb{position:absolute;inset:3px auto 3px 3px;width:calc(50% - 4px);border-radius:11px;background:#344a3b;box-shadow:inset 0 0 0 1px #f4b54466;transition:transform .22s ease;pointer-events:none}
      .view-toggle[data-view="preview"] .view-toggle-thumb{transform:translateX(100%)}
      .view-toggle button{position:relative;z-index:1;flex:1;background:transparent;color:#d8d1be;border:0;min-height:44px;border-radius:11px;font-weight:800}
      .view-toggle button.active{color:#fff}
      .view-toggle button:focus-visible,.mode-picker button:focus-visible,.toolbar button:focus-visible,.import:focus-within{outline:2px solid #f4b544;outline-offset:2px}
      .toolbar button:disabled,.import.disabled{opacity:.35}
      .import.disabled{cursor:default;pointer-events:none}
      .sketch-layers{position:absolute;inset:0;z-index:1;transition:opacity .22s ease}
      .sketch-layers.is-faded{opacity:0}
      .preview-image{z-index:3;opacity:0;transition:opacity .22s ease;pointer-events:none}
      .preview-image.is-visible{opacity:1}
      .preview-image.is-hidden{opacity:0}
      .preview-preload{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:2;opacity:0;pointer-events:none}
      .pencil-glow{position:absolute;inset:0;z-index:4;pointer-events:none;overflow:hidden}
      .canvas-hint{z-index:5}
      .mode-picker{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;background:#13221b;border-radius:12px;overflow:hidden;margin-top:7px;padding:3px}
      .mode-picker button{display:grid;place-items:center;min-height:52px;border:0;border-radius:10px;background:transparent;color:#b8c0b7}
      .mode-picker button.active{background:#344a3b;color:#f4b544;box-shadow:inset 0 0 0 1px #f4b54455}
      .mode-picker svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
      .model-caption{height:18px;margin-top:3px;text-align:center;color:#f5d998;font-size:12px;font-weight:750}
      @media(prefers-reduced-motion:reduce){.view-toggle-thumb,.sketch-layers,.preview-image{transition:none}}
      @media(max-height:680px){.mode-picker button{min-height:46px}}
    `}</style>
  </main>;
}
