"use client";

import { useEffect, useRef } from "react";
import { Mesh, Program, Renderer, Triangle } from "ogl";

type SilkProps = {
  paused?: boolean;
  reducedMotion?: boolean;
  className?: string;
};

const vertex = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

// Adapted from React Bits' Silk (MIT): the shader is kept deliberately subtle
// for the constrained iMessage surface and rendered through the already-bundled
// OGL runtime instead of adding a second WebGL renderer.
const fragment = `
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimary;
uniform vec3 uHighlight;

const float E = 2.71828182845904523536;

float noise(vec2 texCoord) {
  vec2 r = E * sin(E * texCoord);
  return fract(r.x * r.y * (1.0 + texCoord.x));
}

mat2 rotate(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}

void main() {
  vec2 uv = gl_FragCoord.xy / max(uResolution.xy, vec2(1.0));
  vec2 silk = rotate(-0.22) * ((uv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0));
  silk *= 1.35;
  float time = uTime * 0.09;
  silk.y += 0.032 * sin(8.0 * silk.x - time);
  float folds = 0.6 + 0.4 * sin(5.0 * (silk.x + silk.y + cos(3.0 * silk.x + 5.0 * silk.y) + 0.02 * time) + sin(20.0 * (silk.x + silk.y - 0.1 * time)));
  float grain = noise(gl_FragCoord.xy) * 0.02;
  float sheen = smoothstep(0.78, 1.0, folds) * (0.18 + 0.08 * sin(silk.x * 2.0 - time));
  vec3 base = vec3(0.010, 0.016, 0.032);
  vec3 body = base + uPrimary * (0.10 + folds * 0.18) - vec3(grain);
  vec3 result = mix(body, uHighlight * 0.16 + body * 0.84, sheen);
  gl_FragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
`;

/**
 * COAST's midnight-and-electric-blue Silk backdrop. It is decorative: WebGL failures and
 * reduced-motion both fall back to the CSS gradient behind it.
 */
export default function Silk({ paused = false, reducedMotion = false, className = "" }: SilkProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused || reducedMotion);
  const runtimeRef = useRef<{ wake: () => void } | null>(null);

  useEffect(() => {
    pausedRef.current = paused || reducedMotion;
    if (!pausedRef.current) runtimeRef.current?.wake();
  }, [paused, reducedMotion]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || reducedMotion) return;

    let renderer: Renderer | null = null;
    let frame = 0;
    let running = false;
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
          uPrimary: { value: [0.035, 0.15, 0.44] },
          uHighlight: { value: [0.08, 0.33, 0.70] },
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
      const observer = new ResizeObserver(resize);
      observer.observe(container);

      const loop = (now: number) => {
        if (disposed) return;
        if (pausedRef.current) {
          running = false;
          return;
        }
        program.uniforms.uTime.value = now * 0.001;
        renderer?.render({ scene: mesh });
        frame = requestAnimationFrame(loop);
      };
      const wake = () => {
        if (running || disposed || pausedRef.current) return;
        running = true;
        frame = requestAnimationFrame(loop);
      };

      runtimeRef.current = { wake };
      resize();
      wake();
      return () => {
        disposed = true;
        runtimeRef.current = null;
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
        runtimeRef.current = null;
        cancelAnimationFrame(frame);
        renderer?.gl.getExtension("WEBGL_lose_context")?.loseContext();
      };
    }
  }, [reducedMotion]);

  return <div ref={containerRef} className={`silk ${className}`.trim()} aria-hidden="true" />;
}
