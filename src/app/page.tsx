import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <p className={styles.eyebrow}>SAN FRANCISCO · PRIVATE BETA</p>
        <section className={styles.hero}>
          <div className={styles.mark} aria-hidden="true">C</div>
          <div>
            <h1>Meet COAST.</h1>
            <p className={styles.lede}>
              Your unofficial mayor for the city—events, dinner, drinks,
              and a whole night that actually fits you.
            </p>
          </div>
        </section>

        <section className={styles.card} aria-label="Example COAST conversation">
          <p className={styles.you}>You</p>
          <p className={styles.bubble}>Low-key date night in the Mission, under $150?</p>
          <p className={styles.coast}>COAST</p>
          <p className={`${styles.bubble} ${styles.reply}`}>
            Say less. I found three warm, walkable moves with enough energy to
            feel like a night out—not a networking event.
          </p>
        </section>

        <footer className={styles.footer}>
          <span>Grounded in a curated SF places + events database.</span>
          <a href="/api/health">Service status</a>
        </footer>
      </main>
    </div>
  );
}
