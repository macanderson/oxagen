// Global test setup — provides jest-dom matchers for jsdom tests.
// Only runs when the test environment is jsdom (annotated per-file).
import "@testing-library/jest-dom/vitest";

// jsdom does not implement the Pointer Events API. Base UI's interactive
// primitives (Checkbox, Switch, Select, Menu…) construct/inspect PointerEvent
// and use pointer capture in their click handlers, which throws
// "ownerWindow(...).PointerEvent is not a constructor" under jsdom. Polyfill
// the minimum surface so click/interaction tests run. No-op outside jsdom.
if (typeof window !== "undefined") {
  if (typeof window.PointerEvent === "undefined") {
    class PointerEventPolyfill extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      readonly isPrimary: boolean;
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 0;
        this.pointerType = params.pointerType ?? "mouse";
        this.isPrimary = params.isPrimary ?? true;
      }
    }
    // @ts-expect-error — assigning the polyfill onto the jsdom window.
    window.PointerEvent = PointerEventPolyfill;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
}
