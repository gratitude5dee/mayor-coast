"use client";

import { useEffect, useRef } from "react";

type Pointer = { x: number; y: number };
type GlowCursorProps = {
  activeRef: { current: boolean };
  trailRef: { current: Pointer[] };
  colorRef: { current: string };
  widthRef: { current: number };
  /** Increments once per brush stroke so idle render loops can stay stopped. */
  pulse: number;
  reducedMotion: boolean;
  className?: string;
};

const CANVAS_SIZE = 1024;
const AMBER = "244, 181, 68";

/**
 * React Bits-inspired cursor treatment, intentionally drawn in its own UI
 * overlay. The overlay is never composited into COAST's background/stroke
 * canvases, so it cannot appear in uploads or generated images.
 */
export default function GlowCursor({ activeRef, trailRef, colorRef, widthRef, pulse, reducedMotion, className = "" }: GlowCursorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<{ start: () => void } | null>(null);
  const reducedMotionRef = useRef(reducedMotion);

  useEffect(() => { reducedMotionRef.current = reducedMotion; }, [reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    let frame = 0;
    let running = false;
    let releasedAt: number | null = null;
    let disposed = false;
    let width = 1;
    let height = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const drawDot = (point: Pointer, radius: number, color: string, alpha: number, blur: number) => {
      const x = point.x / CANVAS_SIZE * width;
      const y = point.y / CANVAS_SIZE * height;
      context.beginPath();
      context.fillStyle = color;
      context.globalAlpha = alpha;
      context.shadowColor = color;
      context.shadowBlur = blur;
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    };

    const drawSegment = (from: Pointer, to: Pointer, lineWidth: number, color: string, alpha: number, blur: number) => {
      context.beginPath();
      context.moveTo(from.x / CANVAS_SIZE * width, from.y / CANVAS_SIZE * height);
      context.lineTo(to.x / CANVAS_SIZE * width, to.y / CANVAS_SIZE * height);
      context.strokeStyle = color;
      context.globalAlpha = alpha;
      context.lineWidth = lineWidth;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.shadowColor = color;
      context.shadowBlur = blur;
      context.stroke();
    };

    const render = (fade: number) => {
      context.clearRect(0, 0, width, height);
      const trail = reducedMotionRef.current ? trailRef.current.slice(-1) : trailRef.current;
      if (!trail.length || fade <= 0) return;
      const scale = Math.min(width, height) / CANVAS_SIZE;
      const baseWidth = Math.max(2, widthRef.current * scale);
      const denominator = Math.max(1, trail.length - 1);
      context.save();
      context.globalCompositeOperation = "source-over";
      for (let index = 1; index < trail.length; index += 1) {
        const progress = index / denominator;
        const alpha = fade * (0.08 + progress * 0.24);
        drawSegment(trail[index - 1]!, trail[index]!, baseWidth * (2.25 + progress * 0.55), `rgba(${AMBER}, 0.9)`, alpha, baseWidth * (2.8 + progress * 1.5));
        drawSegment(trail[index - 1]!, trail[index]!, baseWidth * (0.78 + progress * 0.2), colorRef.current, fade * (0.24 + progress * 0.42), baseWidth * 1.1);
      }
      const tip = trail.at(-1)!;
      drawDot(tip, Math.max(3, baseWidth * 1.35), `rgba(${AMBER}, 0.95)`, fade * 0.46, baseWidth * 4.2);
      drawDot(tip, Math.max(1.5, baseWidth * 0.48), colorRef.current, fade * 0.92, baseWidth * 1.2);
      context.restore();
    };

    const loop = (now: number) => {
      if (disposed) return;
      if (activeRef.current) releasedAt = null;
      if (!activeRef.current && releasedAt === null) releasedAt = now;
      const fade = activeRef.current ? 1 : reducedMotionRef.current ? 0 : Math.max(0, 1 - (now - (releasedAt ?? now)) / 200);
      render(fade);
      if (activeRef.current || fade > 0) {
        frame = requestAnimationFrame(loop);
      } else {
        running = false;
        context.clearRect(0, 0, width, height);
      }
    };

    runtimeRef.current = {
      start() {
        if (running || disposed || !activeRef.current) return;
        releasedAt = null;
        running = true;
        frame = requestAnimationFrame(loop);
      },
    };
    return () => {
      disposed = true;
      runtimeRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeRef, colorRef, trailRef, widthRef]);

  useEffect(() => { runtimeRef.current?.start(); }, [pulse]);

  return <canvas ref={canvasRef} className={`glow-cursor ${className}`.trim()} aria-hidden="true" />;
}
