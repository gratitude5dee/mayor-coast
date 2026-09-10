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
import controls from "./draw-studio-controls.module.css";
import { ToolcraftButton } from "./toolcraft-controls";
import type { RasterEditorAdapter } from "./tldraw-adapter";

const Silk = dynamic(() => import("./silk"), { ssr: false });
const GlowCursor = dynamic(() => import("./glow-cursor"), { ssr: false });

const TldrawAdapter = dynamic(() => import("./tldraw-adapter"), { ssr: false });

type Props = { sessionId: string; tldrawEnabled?: boolean; tldrawLicenseKey?: string };
type Job = { id: string; state: string; outputUrl?: string; previewUrl?: string; errorCode?: string | null } | null;
type EventItem = { jobId: string; sequence: number; kind: string; state: string; mediaId: string | null; previewIndex: number | null; errorCode: string | null };
type JobSnapshot = { jobId: string; state: string; previewMediaId: string | null; outputMediaId: string | null; errorCode: string | null } | null;
type Revision = { jobId: string; parentJobId: string | null; rootJobId: string | null; revisionNumber: number; mode: DrawMode | null; model: string | null; state: string; outputMediaId: string | null; previewMediaId: string | null; createdAtMs: number };
type DrawView = "sketch" | "preview";
type GlowPoint = { x: number; y: number };

const colors = ["#070a12", "#286dde", "#ef3340", "#26b4ed", "#ffffff"];
const mediaUrl = (sessionId: string, mediaId: string) => `/api/draw/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(mediaId)}`;
const modeLabels: Record<DrawMode, string> = { fast: "Flare Fast", detailed: "Flare Detailed", turbo: "Turbo · 4 steps", hq: "Sunburst HQ" };
const drawModes: DrawMode[] = ["fast", "detailed", "turbo", "hq"];
const classNames = (...items: Array<string | false | null | undefined>) => items.filter(Boolean).join(" ");

function ModeIcon({ mode, className }: { mode: DrawMode; className?: string | undefined }) {
  const props = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.85, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (mode === "fast") return <svg {...props}><path d="m13.2 2.5-8.1 11.1h6.1l-1 7.9 8.6-11.5h-6.3l.7-7.5Z" /></svg>;
  if (mode === "detailed") return <svg {...props}><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 4v4M16 10v4M11 16v4" /><circle cx="8" cy="6" r="1.35" /><circle cx="16" cy="12" r="1.35" /><circle cx="11" cy="18" r="1.35" /></svg>;
  if (mode === "turbo") return <svg {...props}><path d="M14.5 3.2c3.3.1 5.4 1.6 6.1 2.4-.9 4.3-3.2 7.5-7 9.6l-4.8-4.8c2.1-3.8 5.3-6.1 5.7-7.2Z" /><path d="m9 10.2-3.8.8-1.5 3.2 3.4.4M13.8 15.2l-.8 3.8-3.2 1.5-.4-3.4M16.3 7.7h.01" /><path d="m8.2 16.8-2 3.1M6.4 15l-2.7.5" /></svg>;
  return <svg {...props}><circle cx="12" cy="12" r="3.35" /><path d="M12 2.5v2.1M12 19.4v2.1M21.5 12h-2.1M4.6 12H2.5M18.7 5.3l-1.5 1.5M6.8 17.2l-1.5 1.5M18.7 18.7l-1.5-1.5M6.8 6.8 5.3 5.3" /></svg>;
}

type CanvasTool = "undo" | "redo" | "clear" | "import";

function CanvasToolIcon({ tool }: { tool: CanvasTool }) {
  const props = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (tool === "undo") return <svg {...props}><path d="M9 7 4.5 11.5 9 16" /><path d="M5 11.5h8.1a5.4 5.4 0 0 1 5.4 5.4" /></svg>;
  if (tool === "redo") return <svg {...props}><path d="m15 7 4.5 4.5-4.5 4.5" /><path d="M19 11.5h-8.1a5.4 5.4 0 0 0-5.4 5.4" /></svg>;
  if (tool === "clear") return <svg {...props}><path d="m7.5 8.5 6.8-3.9 4.2 7.3-6.8 3.9z" /><path d="m6.2 15 2.2 3.8h9.3" /></svg>;
  return <svg {...props}><path d="M12 15V3.5" /><path d="m7.7 7.8L12 3.5l4.3 4.3" /><path d="M5 14.5v4.2c0 .9.7 1.6 1.6 1.6h10.8c.9 0 1.6-.7 1.6-1.6v-4.2" /></svg>;
}

export default function DrawStudio({ sessionId, tldrawEnabled = false, tldrawLicenseKey }: Props) {
  const strokeCanvasRef = useRef<HTMLCanvasElement>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingSurfaceRef = useRef<HTMLElement>(null);
  const canvasWorkspaceRef = useRef<HTMLDivElement>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);
  const touchDrawingRef = useRef(false);
  const currentRef = useRef<DrawPoint[]>([]);
  const glowTrailRef = useRef<GlowPoint[]>([]);
  const glowActiveRef = useRef(false);
  const glowColorRef = useRef(colors[0]!);
  const glowWidthRef = useRef(18);
  const activeJobIdRef = useRef<string | null>(null);
  const autoPreviewEligibleJobIdRef = useRef<string | null>(null);
  const autoPreviewedJobIdRef = useRef<string | null>(null);
  const explicitViewJobIdRef = useRef<string | null>(null);
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
  const [message, setMessage] = useState("Sketch it, describe it, then make it real.");
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
  const [glowPulse, setGlowPulse] = useState(0);

  const selectView = useCallback((next: DrawView, explicit = true) => {
    if (explicit) explicitViewJobIdRef.current = activeJobIdRef.current;
    setTab(next);
  }, []);

  const applyJob = useCallback((next: { id: string; state: string; previewMediaId?: string | null; outputMediaId?: string | null; errorCode?: string | null }) => {
    const isNew = activeJobIdRef.current !== next.id;
    if (isNew) {
      activeJobIdRef.current = next.id;
      explicitViewJobIdRef.current = null;
      setDecodedPreview(null);
      setTab("sketch");
    }
    setJob((previous) => {
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
  }, [sessionId, setDecodedPreview]);

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
    if (event.kind === "completed" && event.mediaId) {
      setMessage("Image ready. Review it, animate it, or tap Save to send it in iMessage.");
    } else if (event.errorCode) {
      setMessage("This request needs attention. You can start a new image when it clears.");
    } else {
      setMessage(drawJobLabel(event.state));
    }
    if (["delivered", "failed", "terminal_failure", "refused", "cancelled", "expired"].includes(event.state)) requestKeyRef.current = null;
  }, [applyJob, setMessage]);

  const applySnapshot = useCallback((snapshot: JobSnapshot) => {
    if (!snapshot) return;
    if (selectedRevisionRef.current && selectedRevisionRef.current !== snapshot.jobId) return;
    applyJob({ id: snapshot.jobId, state: snapshot.state, previewMediaId: snapshot.previewMediaId, outputMediaId: snapshot.outputMediaId, errorCode: snapshot.errorCode });
    if (snapshot.outputMediaId) {
      setMessage(snapshot.state === "ready_for_save" ? "Image ready. Review it, animate it, or tap Save to send it in iMessage." : drawJobLabel(snapshot.state));
    }
  }, [applyJob, setMessage]);

  const refreshRevisions = useCallback(async () => {
    const response = await fetch(`/api/draw/sessions/${encodeURIComponent(sessionId)}/revisions`, { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json() as { revisions?: Revision[] };
    const nextRevisions = body.revisions ?? [];
    setRevisions(nextRevisions);
    const restored = selectedRevisionRef.current && nextRevisions.find((item) => item.jobId === selectedRevisionRef.current);
    if (restored) {
      applyJob({ id: restored.jobId, state: restored.state, previewMediaId: restored.previewMediaId, outputMediaId: restored.outputMediaId });
    }
  }, [applyJob, sessionId]);

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
      if (canvasViewportRef.current?.contains(event.target as Node)) {
        touchDrawingRef.current = true;
        event.preventDefault();
      }
    };
    const stop = (event: TouchEvent) => {
      if (touchDrawingRef.current && canvasViewportRef.current?.contains(event.target as Node)) event.preventDefault();
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

  const setDrawingSurface = useCallback((node: HTMLElement | null) => {
    drawingSurfaceRef.current = node;
    if (!node) return;
    let frame = 0;
    const sizeCanvas = () => {
      const viewport = canvasViewportRef.current;
      if (!viewport) return;
      const bounds = canvasWorkspaceRef.current?.getBoundingClientRect() ?? node.getBoundingClientRect();
      // The icon rail lives beside the drawing surface. Reserve its fixed
      // touch target so a constrained Messages sheet never causes overlap.
      const edge = Math.floor(Math.min(bounds.width - 56, bounds.height, 720));
      if (edge > 0) viewport.style.setProperty("--coast-draw-canvas-edge", `${edge}px`);
    };
    const observer = new ResizeObserver(sizeCanvas);
    observer.observe(node);
    frame = requestAnimationFrame(sizeCanvas);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
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
  function glowPoint(event: React.PointerEvent<HTMLCanvasElement>): GlowPoint {
    const rect = canvasViewportRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  }
  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (tab !== "sketch") return;
    event.preventDefault(); event.stopPropagation?.(); pointerRef.current = event.pointerId;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* constrained Photon fallback */ }
    const nextPoint = point(event); const nextGlowPoint = glowPoint(event);
    const next = [nextPoint]; currentRef.current = next; setCurrent(next); setDrawing(true);
    glowTrailRef.current = eraser ? [] : [nextGlowPoint];
    glowColorRef.current = color;
    glowWidthRef.current = size;
    glowActiveRef.current = !eraser;
    if (!eraser) setGlowPulse((value) => value + 1);
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (pointerRef.current !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation?.();
    const next = currentRef.current.length >= 4096 ? currentRef.current : [...currentRef.current, point(event)]; const nextGlowPoint = glowPoint(event);
    currentRef.current = next; setCurrent(next);
    if (glowActiveRef.current) glowTrailRef.current = [...glowTrailRef.current.slice(-15), nextGlowPoint];
  }
  function end(event?: React.PointerEvent<HTMLCanvasElement>) {
    if (event && pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    const stroke = completedStroke(currentRef.current, color, size, eraser);
    if (stroke) setStrokes((value) => [...value, stroke]);
    setRedo([]); currentRef.current = []; setCurrent([]); setDrawing(false); glowActiveRef.current = false;
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
      activeJobIdRef.current = null;
      explicitViewJobIdRef.current = null;
      autoPreviewEligibleJobIdRef.current = body.jobId;
      autoPreviewedJobIdRef.current = null;
      setDecodedPreview(null);
      setTab("sketch");
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
  useEffect(() => {
    if (!decodedPreview || !job?.id || decodedPreview.key !== currentPreviewKey) return;
    if (autoPreviewEligibleJobIdRef.current !== job.id || autoPreviewedJobIdRef.current === job.id) return;
    autoPreviewedJobIdRef.current = job.id;
    if (explicitViewJobIdRef.current !== job.id) setTab("preview");
  }, [currentPreviewKey, decodedPreview, job?.id]);
  const showingGeneratedImage = tab === "preview" && Boolean(decodedPreview);
  const sketchEditable = tab === "sketch" && !preparing && !isDrawJobActive(job?.state);
  function viewKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" || event.key === "ArrowLeft" ? "sketch" : "preview";
    if (next === "preview" && !decodedPreview) return;
    selectView(next);
    (event.currentTarget.parentElement?.querySelector(`[data-draw-view="${next}"]`) as HTMLButtonElement | null)?.focus();
  }
  function modeKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentMode: DrawMode) {
    const horizontal = event.key === "ArrowRight" || event.key === "ArrowLeft";
    if (!horizontal && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = drawModes.indexOf(currentMode);
    const next = event.key === "Home" ? drawModes[0]! : event.key === "End" ? drawModes.at(-1)! : drawModes[(index + (event.key === "ArrowRight" ? 1 : -1) + drawModes.length) % drawModes.length]!;
    setMode(next);
    (event.currentTarget.parentElement?.querySelector(`[data-mode="${next}"]`) as HTMLButtonElement | null)?.focus();
  }

  return <main className="draw-shell">
    <div className="effects-backdrop"><Silk paused={drawing || promptFocused || preparing || isDrawJobActive(job?.state)} reducedMotion={reducedMotion} /></div>
    <div className="draw-top-controls">
      <header className="draw-header"><div><p className="eyebrow">COAST DRAW</p><h1>Create</h1></div></header>
      <nav className={controls.viewToggle} data-view={tab} role="tablist" aria-label="Canvas view">
        <span className={controls.viewToggleThumb} aria-hidden="true" />
        <ToolcraftButton className={classNames(controls.viewToggleButton, tab === "sketch" && controls.viewToggleButtonActive)} data-draw-view="sketch" role="tab" aria-selected={tab === "sketch"} aria-controls="draw-canvas-panel" tabIndex={tab === "sketch" ? 0 : -1} onClick={() => selectView("sketch")} onKeyDown={viewKeyDown}>Sketch</ToolcraftButton>
        <ToolcraftButton className={classNames(controls.viewToggleButton, tab === "preview" && controls.viewToggleButtonActive)} data-draw-view="preview" role="tab" aria-selected={tab === "preview"} aria-controls="draw-canvas-panel" tabIndex={tab === "preview" ? 0 : -1} onClick={() => selectView("preview")} onKeyDown={viewKeyDown} disabled={!decodedPreview}>Preview</ToolcraftButton>
      </nav>
      {revisions.length > 0 ? <nav className="revision-strip" aria-label="Image revisions">{revisions.map((revision) => <ToolcraftButton key={revision.jobId} className={selectedRevisionId === revision.jobId ? "selected" : ""} onClick={() => selectRevision(revision)}>{revision.outputMediaId || revision.previewMediaId ? <img src={mediaUrl(sessionId, revision.outputMediaId ?? revision.previewMediaId!)} alt="" draggable={false} /> : null}<span>R{revision.revisionNumber}</span><small>{revision.mode ? modeLabels[revision.mode] : "Image"}</small><em>{revision.state === "ready_for_save" ? "Ready" : drawJobLabel(revision.state)}</em></ToolcraftButton>)}</nav> : null}
    </div>
    <section className="canvas-zone" ref={setDrawingSurface} id="draw-canvas-panel"><div ref={canvasWorkspaceRef} className="canvas-workspace"><div className="canvas-utility-rail" aria-label="Canvas actions"><ToolcraftButton className="canvas-icon-button" aria-label="Undo" title="Undo" disabled={!sketchEditable || (!useTldraw && !strokes.length)} onClick={() => { if (useTldraw) tldrawAdapterRef.current?.undo(); else { const stroke = strokes.at(-1); if (stroke) { setRedo((items) => [...items, stroke]); setStrokes((items) => items.slice(0, -1)); } } }}><CanvasToolIcon tool="undo" /></ToolcraftButton><ToolcraftButton className="canvas-icon-button" aria-label="Redo" title="Redo" disabled={!sketchEditable || (!useTldraw && !redo.length)} onClick={() => { if (useTldraw) tldrawAdapterRef.current?.redo(); else { const stroke = redo.at(-1); if (stroke) { setStrokes((items) => [...items, stroke]); setRedo((items) => items.slice(0, -1)); } } }}><CanvasToolIcon tool="redo" /></ToolcraftButton><ToolcraftButton className="canvas-icon-button" aria-label="Clear sketch" title="Clear sketch" disabled={!sketchEditable} onClick={() => { if (useTldraw) tldrawAdapterRef.current?.clear(); else { setStrokes([]); setRedo([]); } }}><CanvasToolIcon tool="clear" /></ToolcraftButton><label className={`canvas-icon-button import-icon ${!sketchEditable ? "disabled" : ""}`} aria-label="Import image" title="Import image"><CanvasToolIcon tool="import" /><span className="sr-only">Import image</span><input type="file" accept="image/jpeg,image/png,image/webp" disabled={!sketchEditable} onChange={(event) => void importImage(event.target.files?.[0])} /></label></div><div ref={canvasViewportRef} className="viewport" data-testid="draw-canvas-viewport"><div className={`sketch-layers ${showingGeneratedImage ? "is-faded" : ""}`} aria-hidden="true">{useTldraw && tldrawLicenseKey ? <TldrawAdapter licenseKey={tldrawLicenseKey} onReady={(adapter) => { tldrawAdapterRef.current = adapter; adapter.setBrush(color, size); }} /> : <><canvas ref={backgroundCanvasRef} className="layer" /><canvas ref={strokeCanvasRef} className="layer" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onContextMenu={(event) => event.preventDefault()} aria-label="COAST drawing canvas" data-testid="draw-canvas" /></>}</div>{currentPreviewUrl ? <img className={`preview-image ${showingGeneratedImage ? "is-visible" : "is-hidden"}`} src={decodedPreview?.url ?? currentPreviewUrl} alt="COAST generated preview" draggable={false} /> : null}{currentPreviewUrl && decodedPreview?.url !== currentPreviewUrl ? <img className="preview-preload" src={currentPreviewUrl} alt="" aria-hidden="true" draggable={false} onLoad={() => setDecodedPreview({ key: currentPreviewKey ?? "", url: currentPreviewKey ? currentPreviewUrl : "" })} onError={() => setMessage("The image is ready, but its preview could not load. Reopen the card and try again.")} /> : null}<GlowCursor activeRef={glowActiveRef} trailRef={glowTrailRef} colorRef={glowColorRef} widthRef={glowWidthRef} pulse={glowPulse} reducedMotion={reducedMotion} className="pencil-glow" /><span className="canvas-hint">1024 × 1024</span></div></div></section>
    <section className="ink-controls" aria-label="Ink controls"><div className="palette">{colors.map((value) => <ToolcraftButton key={value} className={`swatch ${color === value && !eraser ? "selected" : ""}`} style={{ background: value }} aria-label={`Use ${value}`} disabled={!sketchEditable} onClick={() => { setColor(value); setEraser(false); tldrawAdapterRef.current?.setBrush(value, size); }} />)}</div><label className="size">Size <input type="range" min="4" max="64" value={size} disabled={!sketchEditable} aria-label="Brush size" onChange={(event) => { const next = Number(event.target.value); setSize(next); tldrawAdapterRef.current?.setBrush(color, next); }} /></label><ToolcraftButton className={`eraser-button ${eraser ? "selected" : ""}`} aria-pressed={eraser} disabled={!sketchEditable} onClick={() => setEraser((value) => { const next = !value; tldrawAdapterRef.current?.setEraser(next); return next; })}>Eraser</ToolcraftButton></section>
    <section className="bottom-sheet"><textarea value={prompt} onFocus={() => setPromptFocused(true)} onBlur={() => setPromptFocused(false)} onChange={(event) => setPrompt(event.target.value)} placeholder={refining ? "Follow-up instruction, e.g. Make the sky sunset" : "Describe the image (optional)"} aria-label="Prompt" /><div className={controls.modePicker} role="radiogroup" aria-label="Generation mode">{drawModes.map((item) => <ToolcraftButton key={item} data-mode={item} className={classNames(controls.modeButton, mode === item && controls.modeButtonActive)} role="radio" aria-checked={mode === item} aria-label={modeLabels[item]} title={modeLabels[item]} tabIndex={mode === item ? 0 : -1} onClick={() => setMode(item)} onKeyDown={(event) => modeKeyDown(event, item)}><ModeIcon mode={item} className={controls.modeIcon} /></ToolcraftButton>)}</div><div className={controls.modelCaption} aria-live="polite">{modeLabels[mode]}</div>{refining ? <button className={`context-reset ${resetContext ? "selected" : ""}`} onClick={() => setResetContext((value) => !value)}>{resetContext ? "Starting fresh from this image" : "Start fresh from this image"}</button> : null}<div className="actions">{ready ? <><button className="discard" onClick={() => void cancel()}>Discard</button><button className="secondary" disabled={animating} onClick={() => void animate()}>{animating ? "Starting…" : "Animate"}</button><button className="save" disabled={saving || job?.state !== "ready_for_save"} onClick={() => void save()}>{saving ? "Saving…" : "Save to iMessage"}</button></> : isDrawJobActive(job?.state) ? <button className="cancel" onClick={() => void cancel()}>Cancel</button> : <button className="generate" disabled={preparing || !authorized || tab === "preview"} onClick={() => void generate()}>{preparing ? "Preparing…" : "Generate"}</button>}</div><p className="message" aria-live="polite">{message}</p>{ready ? <button className="refine" onClick={refine}>Draw on this result</button> : null}</section>
    <style>{`
      html,body{height:100%;margin:0;overscroll-behavior:none;background:#13221b}
      *{box-sizing:border-box}.draw-shell{height:var(--coast-draw-vvh,100dvh);overflow:hidden;overscroll-behavior:none;background:#13221b;color:#f8f1df;padding:max(8px,env(safe-area-inset-top)) max(10px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left));font-family:ui-sans-serif,system-ui;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:7px}.draw-top-controls{display:grid;gap:7px;min-width:0}.draw-header,.tabs,.toolbar,.bottom-sheet,.revision-strip{width:min(100%,720px);margin:0 auto}.draw-header{display:flex;justify-content:space-between;align-items:center}.eyebrow{color:#f4b544;letter-spacing:.16em;font-size:10px;font-weight:850;margin:0 0 2px}h1{font-size:22px;line-height:1.05;margin:0}.status{font-size:12px;color:#f4b544;text-align:right}.tabs{display:flex;gap:4px}.tabs button,.mode-toggle button{background:transparent;color:#d8d1be;border:0;padding:9px 13px;min-height:44px;border-radius:12px;font-weight:750}.tabs button.active,.mode-toggle button.active{background:#344a3b;color:#fff}.tabs button:disabled{opacity:.35}.revision-strip{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}.revision-strip button{display:grid;gap:1px;min-width:76px;min-height:48px;padding:6px 9px;text-align:left;color:#f8f1df;border:1px solid #526357;border-radius:10px;background:#1d3025}.revision-strip button.selected{border-color:#f4b544;background:#344a3b}.revision-strip img{width:44px;height:28px;object-fit:cover;border-radius:5px;pointer-events:none}.revision-strip small,.revision-strip em{font-size:9px;font-style:normal;color:#d8d1be;white-space:nowrap}.revision-strip em{color:#f4b544}.toolbar{display:flex;align-items:center;gap:6px;overflow-x:auto;scrollbar-width:none;padding:1px 0}.toolbar button,.import{border:0;background:#344a3b;color:#f8f1df;border-radius:10px;min-height:44px;padding:8px 11px;white-space:nowrap;font-weight:700}.toolbar button:disabled{opacity:.35}.toolbar .selected{outline:2px solid #f4b544}.palette{display:flex;gap:5px}.swatch{width:34px!important;padding:0!important;border:2px solid #f8f1df!important;border-radius:50%!important;flex:0 0 34px}.size{display:flex;align-items:center;gap:4px;color:#f5d998;font-size:12px;white-space:nowrap}.size input{width:72px}.import{position:relative;cursor:pointer}.import input{position:absolute;inset:0;opacity:0;width:100%;height:100%}.canvas-zone{min-height:0;display:grid;place-items:center;overscroll-behavior:contain;touch-action:none}.viewport{position:relative;width:min(100%,720px);height:auto;max-height:100%;aspect-ratio:1;background:#fff;border-radius:14px;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;box-shadow:0 8px 30px #0003}.layer,.preview-image{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;touch-action:none;user-select:none;-webkit-user-drag:none}.tldraw-stage{position:absolute;inset:0}.hidden{visibility:hidden}.preview-image{z-index:3}.canvas-hint{position:absolute;right:9px;bottom:7px;color:#777;background:#fff9;border-radius:7px;padding:3px 6px;font-size:10px;z-index:4}.bottom-sheet{max-height:min(34dvh,250px);overflow:auto;background:#1d3025;border:1px solid #3d5548;border-radius:16px;padding:8px;overscroll-behavior:contain}.bottom-sheet textarea{width:100%;min-height:48px;max-height:96px;resize:vertical;border:1px solid #526357;background:#25352b;color:#fff;border-radius:10px;padding:9px;font:inherit}.mode-toggle{display:flex;background:#13221b;border-radius:12px;overflow-x:auto;margin-top:7px}.mode-toggle button{white-space:nowrap;flex:1;font-size:12px;padding-inline:9px}.context-reset{width:100%;border:1px solid #526357;border-radius:9px;background:#13221b;color:#f8f1df;min-height:34px;margin-top:7px;font-weight:700}.context-reset.selected{border-color:#f4b544;color:#f4b544}.actions{display:flex;gap:6px;margin-top:7px}.generate,.cancel,.save,.discard,.secondary{border:0;border-radius:11px;min-height:44px;font-size:14px;font-weight:850}.generate,.save{background:#f4b544;color:#13221b;flex:1}.cancel,.discard{background:#7e4638;color:#fff;padding:0 13px}.secondary{background:#344a3b;color:#f8f1df;padding:0 12px}.save:disabled{opacity:.55}.message{font-size:12px;color:#d8d1be;margin:6px 2px 0;min-height:15px}.refine{width:100%;border:0;background:#f4b544;color:#13221b;border-radius:10px;min-height:40px;font-weight:850;margin-top:6px}@media(max-height:680px){.draw-shell{gap:4px}.draw-top-controls{gap:4px}.toolbar button,.import{min-height:40px}.bottom-sheet{max-height:205px}.bottom-sheet textarea{min-height:40px}.mode-toggle button{min-height:38px}.draw-header h1{font-size:19px}}@media(min-width:760px){.draw-shell{padding:16px}.toolbar{justify-content:center}.bottom-sheet{padding:12px;max-height:270px}}`}</style>
    <style>{`
      .draw-shell{position:relative;isolation:isolate;background:transparent}
      html,body{background:#05070c}
      .effects-backdrop{position:absolute;inset:0;z-index:0;pointer-events:none;background:radial-gradient(circle at 84% 8%,#3ca7ff1c 0%,transparent 24%),radial-gradient(circle at 50% 10%,#08172f 0%,#05070c 53%,#010205 100%)}
      .silk{position:absolute;inset:0;opacity:.78}
      .draw-top-controls,.canvas-zone,.ink-controls,.bottom-sheet{position:relative;z-index:1}
      .draw-shell{background:#05070c;color:#f8fbff}
      .draw-shell{grid-template-rows:auto minmax(0,1fr) auto auto}
      .draw-header{justify-content:center;padding:2px 3px;text-align:center}.draw-header h1{letter-spacing:-.035em;text-shadow:0 1px 18px #3ca7ff26}.eyebrow{color:#72bdff;text-shadow:0 0 14px #3ca7ff55}
      .bottom-sheet{background:linear-gradient(135deg,#111d35d9,#080d1ae8);border-color:#75baff44;box-shadow:inset 0 1px #e6f4ff1c,0 18px 42px #0007;backdrop-filter:blur(24px) saturate(135%);-webkit-backdrop-filter:blur(24px) saturate(135%)}.bottom-sheet textarea{background:#12213a9c;border-color:#7dbfff55;color:#f8fbff;box-shadow:inset 0 1px #eff8ff12}.toolbar button,.import,.secondary{background:#183354aa;color:#f8fbff;box-shadow:inset 0 1px #e8f5ff18}.toolbar .selected{outline-color:#4db0ff;box-shadow:inset 0 1px #eff8ff30,0 0 0 1px #3ca7ff55,0 8px 20px #0d62c744}.size,.message{color:#dbe8ff}.revision-strip button{background:#0b111ebd;border-color:#6dadf044;color:#f8fbff;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}.revision-strip button.selected{background:#123d72c7;border-color:#4db0ff}.revision-strip small{color:#dbe8ff}.revision-strip em{color:#9dd8ff}.context-reset{background:#0b1425c9;border-color:#5d9de455;color:#f8fbff}.context-reset.selected{border-color:#4db0ff;color:#9dd8ff}.mode-toggle{background:#070a12}.generate,.save,.refine{background:linear-gradient(135deg,#2f8be8,#1760c8);color:#f8fbff;box-shadow:inset 0 1px #eff9ff4a,0 10px 22px #0a52b64c}.canvas-hint{color:#625d6c}.import:focus-within,.toolbar button:focus-visible{outline-color:#6bc0ff}.size input{accent-color:#3ca7ff}
      .canvas-workspace{width:min(100%,776px);height:100%;min-height:0;display:flex;align-items:center;justify-content:center;gap:8px}.canvas-utility-rail{display:grid;grid-auto-rows:44px;gap:7px;flex:0 0 48px}.canvas-icon-button{position:relative;display:grid;place-items:center;width:48px;min-height:44px;padding:0;border:1px solid #6facf144;border-radius:14px;background:linear-gradient(135deg,#17345a91,#0a1427d9);color:#dbeeff;box-shadow:inset 0 1px #eff8ff20,0 8px 20px #0004;backdrop-filter:blur(18px) saturate(135%);-webkit-backdrop-filter:blur(18px) saturate(135%);cursor:pointer}.canvas-icon-button svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.canvas-icon-button:disabled,.canvas-icon-button.disabled{opacity:.35;cursor:default}.canvas-icon-button:focus-visible,.canvas-icon-button:focus-within{outline:2px solid #6bc0ff;outline-offset:2px}.import-icon input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.import-icon.disabled{pointer-events:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .ink-controls{display:flex;align-items:center;gap:7px;width:min(100%,720px);min-height:56px;margin:0 auto;padding:6px 8px;overflow-x:auto;scrollbar-width:none;border:1px solid #5c99e433;border-radius:18px;background:linear-gradient(135deg,#17345a7a,#070d1be0);box-shadow:inset 0 1px #d4ecff18,0 10px 28px #0005;backdrop-filter:blur(20px) saturate(135%);-webkit-backdrop-filter:blur(20px) saturate(135%)}.ink-controls .palette{display:flex;gap:5px;flex:0 0 auto}.ink-controls .swatch{display:block;width:34px;min-height:34px;padding:0;border:2px solid #f8fbff;border-radius:50%;flex:0 0 34px}.ink-controls .swatch.selected{outline:2px solid #4db0ff;outline-offset:2px;box-shadow:0 0 0 1px #3ca7ff55,0 0 17px #3ca7ff77}.ink-controls .swatch:disabled{opacity:.35}.ink-controls .size{display:flex;align-items:center;gap:5px;flex:0 0 auto;color:#dbe8ff;font-size:12px;white-space:nowrap}.ink-controls .size input{width:70px;accent-color:#3ca7ff}.eraser-button{min-height:44px;padding:8px 12px;flex:0 0 auto;border:1px solid #6facf144;border-radius:12px;background:#183354aa;color:#f8fbff;font-weight:750;box-shadow:inset 0 1px #e8f5ff18}.eraser-button.selected{border-color:#4db0ff;box-shadow:inset 0 1px #eff8ff30,0 0 0 1px #3ca7ff55}.eraser-button:disabled{opacity:.35}.eraser-button:focus-visible{outline:2px solid #6bc0ff;outline-offset:2px}
      .size,.message{color:#dbe8ff}.revision-strip button{background:#0b111ebd;border-color:#6dadf044;color:#f8fbff;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}.revision-strip button.selected{background:#123d72c7;border-color:#4db0ff}.revision-strip small{color:#dbe8ff}.revision-strip em{color:#9dd8ff}.context-reset{background:#0b1425c9;border-color:#5d9de455;color:#f8fbff}.context-reset.selected{border-color:#4db0ff;color:#9dd8ff}.mode-toggle{background:#070a12}.generate,.save,.refine{background:linear-gradient(135deg,#2f8be8,#1760c8);color:#f8fbff;box-shadow:inset 0 1px #eff9ff4a,0 10px 22px #0a52b64c}.canvas-hint{color:#625d6c}.size input{accent-color:#3ca7ff}
      .view-toggle{position:relative;display:flex;justify-content:center;gap:2px;padding:3px;background:#122118d9;border:1px solid #526357;border-radius:14px;overflow:hidden}
      .view-toggle-thumb{position:absolute;inset:3px auto 3px 3px;width:calc(50% - 4px);border-radius:11px;background:#344a3b;box-shadow:inset 0 0 0 1px #f4b54466;transition:transform .22s ease;pointer-events:none}
      .view-toggle[data-view="preview"] .view-toggle-thumb{transform:translateX(100%)}
      .view-toggle button{position:relative;z-index:1;flex:1;background:transparent;color:#d8d1be;border:0;min-height:44px;border-radius:11px;font-weight:800}
      .view-toggle button.active{color:#fff}
      .view-toggle button:focus-visible,.mode-picker button:focus-visible{outline:2px solid #6bc0ff;outline-offset:2px}
      .sketch-layers{position:absolute;inset:0;z-index:1;transition:opacity .22s ease}
      .sketch-layers.is-faded{opacity:0}
      .preview-image{z-index:3;opacity:0;transition:opacity .22s ease;pointer-events:none}
      .preview-image.is-visible{opacity:1}
      .preview-image.is-hidden{opacity:0}
      .preview-preload{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:2;opacity:0;pointer-events:none}
      .pencil-glow{position:absolute;inset:0;z-index:4;width:100%;height:100%;display:block;pointer-events:none;overflow:hidden}
      .canvas-hint{z-index:5}
      .mode-picker{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;background:#13221b;border-radius:12px;overflow:hidden;margin-top:7px;padding:3px}
      .mode-picker button{display:grid;place-items:center;min-height:52px;border:0;border-radius:10px;background:transparent;color:#b8c0b7}
      .mode-picker button.active{background:#344a3b;color:#f4b544;box-shadow:inset 0 0 0 1px #f4b54455}
      .mode-picker svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
      .model-caption{height:18px;margin-top:3px;text-align:center;color:#f5d998;font-size:12px;font-weight:750}
      @media(prefers-reduced-motion:reduce){.view-toggle-thumb,.sketch-layers,.preview-image{transition:none}}
      @media(max-height:680px){.draw-shell{gap:4px}.canvas-utility-rail{gap:4px;grid-auto-rows:40px}.canvas-icon-button{min-height:40px}.ink-controls{min-height:50px;padding-block:4px}.mode-picker button{min-height:46px}}
    `}</style>
    <style>{`.viewport{width:var(--coast-draw-canvas-edge,min(100%,720px));height:var(--coast-draw-canvas-edge,min(100%,720px));max-height:none}`}</style>
  </main>;
}
