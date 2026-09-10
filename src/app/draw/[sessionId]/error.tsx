"use client";

export default function DrawError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main style={{ minHeight: "100vh", background: "#05070c", color: "#f8fbff", display: "grid", placeItems: "center", padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <section style={{ maxWidth: 420, textAlign: "center" }}>
        <p style={{ color: "#66b7ff", fontWeight: 800, letterSpacing: ".12em" }}>COAST DRAW</p>
        <h1>The canvas needs a quick reset.</h1>
        <p>Your drawing session is still safe. Reload the canvas and continue.</p>
        <button onClick={reset} style={{ border: 0, borderRadius: 12, padding: "12px 18px", background: "#286dde", color: "#f8fbff", fontWeight: 800 }}>Reload canvas</button>
      </section>
    </main>
  );
}
