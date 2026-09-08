"use client";

export default function DrawError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main style={{ minHeight: "100vh", background: "#17231d", color: "#f8f1df", display: "grid", placeItems: "center", padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <section style={{ maxWidth: 420, textAlign: "center" }}>
        <p style={{ color: "#f4b544", fontWeight: 800, letterSpacing: ".12em" }}>COAST DRAW</p>
        <h1>The canvas needs a quick reset.</h1>
        <p>Your drawing session is still safe. Reload the canvas and continue.</p>
        <button onClick={reset} style={{ border: 0, borderRadius: 12, padding: "12px 18px", background: "#f4b544", color: "#17231d", fontWeight: 800 }}>Reload canvas</button>
      </section>
    </main>
  );
}
