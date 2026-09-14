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

// Web Storage polyfill. Until Node 25 a default-on `localStorage` global
// papered over the fact that neither this config's `node` environment nor the
// jsdom docblock files (opaque origin — jsdom refuses storage there) provided
// one; Node 26 put it behind --localstorage-file and 237 tests discovered the
// gap at once. An in-memory implementation keeps every test hermetic on every
// Node, and `configurable` keeps it replaceable for the tests that simulate a
// throwing or absent store (private-mode degradation).
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}
for (const name of ["localStorage", "sessionStorage"] as const) {
  let present = false;
  try {
    // Reading the property can itself throw (jsdom's opaque-origin guard).
    present = typeof globalThis[name] !== "undefined";
  } catch {
    present = false;
  }
  if (!present) {
    Object.defineProperty(globalThis, name, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}
