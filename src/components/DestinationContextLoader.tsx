import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from "react";

const DestinationContext = lazy(() => import("./DestinationContext").then((module) => ({ default: module.DestinationContext })));

class ContextCodeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <section aria-label="Monitoring details and local conditions">
      <h3>Monitoring details and local conditions</h3>
      <p role="alert">Monitoring details and local conditions could not load. Destination alerts are still available.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload page to retry monitoring details and local conditions</button>
    </section>;
    return this.props.children;
  }
}

export function DestinationContextLoader(props: ComponentProps<typeof DestinationContext>) {
  return <ContextCodeBoundary>
    <Suspense fallback={<p role="status" style={{ minHeight: "4rem" }}>Loading monitoring details and local conditions…</p>}>
      <DestinationContext {...props} />
    </Suspense>
  </ContextCodeBoundary>;
}
