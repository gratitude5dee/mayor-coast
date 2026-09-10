"use client";

import { useEffect, useRef } from "react";
import { Mesh, Program, Renderer, Triangle } from "ogl";

type Pointer = { x: number; y: number };
type GlowCursorProps = {
  activeRef: { current: boolean };
  pointRef: { current: Pointer | null };
  className?: string;
};

const vertex = `attribute vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
const fragment = `
precision highp float;
uniform vec2 uResolution;
uniform vec2 uPointer;
uniform float uActive;
uniform float uFade;
void main() {
  vec2 uv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
  float distanceToPointer = distance(uv, uPointer);
  float glow = smoothstep(0.16, 0.0, distanceToPointer) * uActive * uFade;
  vec3 amber = vec3(1.0, 0.57, 0.08);
  float core = smoothstep(0.035, 0.0, distanceToPointer) * uActive * uFade;
  if (glow < 0.002) discard;
  gl_FragColor = vec4(mix(amber * 0.65, vec3(1.0, 0.88, 0.55), core), glow * 0.22);
}
`;

/** React Bits-inspired, pointer-fed pencil glow. It never receives drawing input. */
export default function GlowCursor({ activeRef, pointRef, className = "" }: GlowCursorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fadeRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let renderer: Renderer | null = null;
    let frame = 0;
    let disposed = false;
    try {
      renderer = new Renderer({ alpha: true, antialias: false, dpr: 1 });
      const gl = renderer.gl;
      gl.clearColor(0, 0, 0, 0);
      const geometry = new Triangle(gl);
      const program = new Program(gl, {
        vertex,
        fragment,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: { uResolution: { value: [1, 1] }, uPointer: { value: [0.5, 0.5] }, uActive: { value: 0 }, uFade: { value: 0 } },
      });
      const mesh = new Mesh(gl, { geometry, program });
      const canvas = gl.canvas;
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText = "display:block;width:100%;height:100%;mix-blend-mode:normal;";
      container.appendChild(canvas);
      const resize = () => {
        const rect = container.getBoundingClientRect();
        renderer?.setSize(Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)));
        program.uniforms.uResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight];
      };
      const observer = new ResizeObserver(resize);
      observer.observe(container);
      const loop = () => {
        if (disposed) return;
        const active = activeRef.current && pointRef.current;
        fadeRef.current += ((active ? 1 : 0) - fadeRef.current) * (active ? 0.34 : 0.25);
        if (pointRef.current) {
          const rect = container.getBoundingClientRect();
          program.uniforms.uPointer.value = [pointRef.current.x / 1024, 1 - pointRef.current.y / 1024];
          if (rect.width <= 0 || rect.height <= 0) program.uniforms.uFade.value = 0;
        }
        program.uniforms.uActive.value = active ? 1 : 0;
        program.uniforms.uFade.value = fadeRef.current;
        renderer?.render({ scene: mesh });
        frame = requestAnimationFrame(loop);
      };
      resize();
      frame = requestAnimationFrame(loop);
      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
        geometry.remove();
        program.remove();
        if (canvas.parentNode === container) container.removeChild(canvas);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      };
    } catch {
      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
        if (renderer) renderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
      };
    }
  }, [activeRef, pointRef]);

  return <div ref={containerRef} className={`glow-cursor ${className}`.trim()} aria-hidden="true" />;
}
