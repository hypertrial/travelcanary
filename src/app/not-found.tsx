import styles from "./not-found.module.css";

export default function NotFound() {
  return <main className={styles.page}>
    <section className={styles.card}>
      <p className={styles.brand}>TravelCanary · 404</p>
      <h1>Page not found</h1>
      <p>This link does not lead to a TravelCanary page. Return to the map to search for a destination.</p>
      {/* Match the brand home link without loading the client router for recovery. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/">Return to the map</a>
    </section>
  </main>;
}
