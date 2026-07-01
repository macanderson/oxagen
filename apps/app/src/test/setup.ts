// Vitest global setup. Registers @testing-library/jest-dom matchers on `expect`
// (e.g. toBeInTheDocument, toHaveAttribute). Matcher registration is DOM-free,
// so importing here is safe for both the default `node` environment and the
// per-file `// @vitest-environment jsdom` component tests. Component render
// tests must still declare the jsdom docblock at the top of the file.
import "@testing-library/jest-dom/vitest";

// ResizeObserver polyfill. jsdom does not implement it, but our shared
// <TruncatedText> primitive (used across chat tool-use cards, memory rows, and
// anything that transitively renders them) observes its element to detect
// overflow. Define a no-op once, globally, so every component test — including
// those that only render TruncatedText transitively — mounts without a manual
// per-file shim. No-op in the `node` env where it is simply never used.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}
