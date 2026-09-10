"use client";

import { useEffect, useRef } from "react";
import { Mesh, Program, Renderer, Triangle } from "ogl";

type GhostFibersProps = {
  paused?: boolean;
  reducedMotion?: boolean;
  className?: string;
};

const vertex = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const fragment = `
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform float uPaused;
void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / max(uResolution.y, 1.0);
  float t = uTime * (1.0 - uPaused);
  float fibers = 0.0;
  for (float i = 0.0; i < 4.0; i += 1.0) {
    float wave = sin(uv.x * (3.0 + i * 0.8) + uv.y * 2.0 + t * (0.12 + i * 0.02) + i) * 0.12;
    fibers += smoothstep(0.018, 0.0, abs(uv.y - wave - sin(uv.x * 1.4 + t * 0.08 + i) * 0.18 - i * 0.13)) / (i + 1.0);
  }
  float glow = exp(-2.0 * dot(uv, uv));
  vec3 base = vec3(0.075, 0.14, 0.105);
  vec3 sage = vec3(0.31, 0.48, 0.37) * fibers * 0.14;
  vec3 amber = vec3(0.95, 0.61, 0.18) * glow * 0.035;
  gl_FragColor = vec4(base + sage + amber, 1.0);
}
`;

/** Lightweight React Bits GhostFibers adaptation. The static CSS background remains the fallback. */
export default function GhostFibers({ paused = false, reducedMotion = false, className = "" }: GhostFibersProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused || reducedMotion);

  useEffect(() => {
    pausedRef.current = paused || reducedMotion;
  }, [paused, reducedMotion]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || reducedMotion) return;
    let renderer: Renderer | null = null;
    let frame = 0;
    let disposed = false;
    try {
      renderer = new Renderer({ alpha: false, antialias: false, dpr: 1 });
      const gl = renderer.gl;
      const geometry = new Triangle(gl);
      const program = new Program(gl, {
        vertex,
        fragment,
        uniforms: {
          uResolution: { value: [1, 1] },
          uTime: { value: 0 },
          uPaused: { value: pausedRef.current ? 1 : 0 },
        },
      });
      const mesh = new Mesh(gl, { geometry, program });
      const canvas = gl.canvas;
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText = "display:block;width:100%;height:100%;";
      container.appendChild(canvas);

      const resize = () => {
        const rect = container.getBoundingClientRect();
        renderer?.setSize(Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)));
        program.uniforms.uResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight];
      };
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);
      const loop = (now: number) => {
        if (disposed) return;
        program.uniforms.uTime.value = now * 0.001;
        program.uniforms.uPaused.value = pausedRef.current ? 1 : 0;
        if (!pausedRef.current) renderer?.render({ scene: mesh });
        frame = requestAnimationFrame(loop);
      };
      resize();
      frame = requestAnimationFrame(loop);
      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        geometry.remove();
        program.remove();
        if (canvas.parentNode === container) container.removeChild(canvas);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      };
    } catch {
      // WebGL is decorative. The container's CSS gradient remains visible.
      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
        if (renderer) renderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
      };
    }
  }, [reducedMotion]);

  return <div ref={containerRef} className={`ghost-fibers ${className}`.trim()} aria-hidden="true" />;
}
