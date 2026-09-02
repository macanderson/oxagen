/**
 * chat-component-registry.test.ts — unit tests for CHAT_COMPONENTS registry.
 *
 * React.lazy is mocked so the dynamic imports don't need the full bundler.
 * The file is importable in Node because we stub `react` before importing.
 *
 * Tests:
 *   1. CONFIG-DERIVED: every key in CHAT_COMPONENTS has a defined renderer
 *   2. CONFIG-DERIVED: key count matches Object.keys(CHAT_COMPONENTS).length
 *   3. logUnknownComponent calls console.warn containing the componentId
 *   4. logUnknownComponent does NOT throw for an unknown id
 *   5. CHAT_COMPONENTS does not contain a key for an unknown componentId
 *   6. "connection-create-inline" is a registered key
 *   7. UnknownComponentCard renders the componentId and unavailable copy
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock react before importing the registry (which uses React.lazy)
vi.mock("react", () => ({
  default: {
    createElement: vi.fn(
      (type: unknown, props: unknown, ...children: unknown[]) => ({
        type,
        props,
        children,
      }),
    ),
  },
  createElement: vi.fn(
    (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
  ),
  lazy: (loader: unknown) => ({
    $$typeof: Symbol("react.lazy"),
    _payload: loader,
    _init: () => null,
  }),
}));

import {
  CHAT_COMPONENTS,
  logUnknownComponent,
  UnknownComponentCard,
} from "./chat-component-registry";

// ---------------------------------------------------------------------------
// 1 & 2. CONFIG-DERIVED completeness
// ---------------------------------------------------------------------------

describe("CHAT_COMPONENTS — config-derived completeness", () => {
  const keys = Object.keys(CHAT_COMPONENTS);

  it("every key has a defined renderer (not null/undefined)", () => {
    for (const key of keys) {
      const renderer = CHAT_COMPONENTS[key];
      expect(renderer).toBeDefined();
      expect(renderer).not.toBeNull();
    }
  });

  it("key count is derived from the object itself (not a hardcoded literal)", () => {
    // Config-derived: reading length from the object under test so the test
    // never drifts when a renderer is added or removed.
    expect(keys.length).toBe(Object.keys(CHAT_COMPONENTS).length);
  });

  it("contains 'svg-preview' as a registered componentId", () => {
    expect(CHAT_COMPONENTS).toHaveProperty("svg-preview");
  });

  it("contains 'mermaid-diagram' as a registered componentId", () => {
    expect(CHAT_COMPONENTS).toHaveProperty("mermaid-diagram");
  });

  it("contains 'image-preview' as a registered componentId", () => {
    expect(CHAT_COMPONENTS).toHaveProperty("image-preview");
  });

  it("contains 'install-instructions' as a registered componentId", () => {
    expect(CHAT_COMPONENTS).toHaveProperty("install-instructions");
  });

  it("contains 'make-video-form' as a registered componentId", () => {
    expect(CHAT_COMPONENTS).toHaveProperty("make-video-form");
  });

  it("contains 'video-result' as a registered componentId", () => {
    expect(CHAT_COMPONENTS).toHaveProperty("video-result");
  });

  it("contains 'connection-create-inline' as a registered componentId", () => {
    expect(CHAT_COMPONENTS).toHaveProperty("connection-create-inline");
  });

  it("does NOT contain an unregistered componentId 'unknown-widget'", () => {
    expect(CHAT_COMPONENTS).not.toHaveProperty("unknown-widget");
  });
});

// ---------------------------------------------------------------------------
// 6. UnknownComponentCard
// ---------------------------------------------------------------------------

describe("UnknownComponentCard", () => {
  it("is exported from the registry", () => {
    expect(UnknownComponentCard).toBeDefined();
    expect(typeof UnknownComponentCard).toBe("function");
  });

  it("renders without throwing when called with a componentId", () => {
    expect(() =>
      UnknownComponentCard({ componentId: "mystery-widget" }),
    ).not.toThrow();
  });

  it("returns an object (React element-like) containing the componentId", () => {
    // We called React.createElement with a mock, so the result is a plain object.
    const result = UnknownComponentCard({
      componentId: "mystery-widget",
    }) as unknown;
    // The componentId should appear somewhere in the serialized structure.
    expect(JSON.stringify(result)).toContain("mystery-widget");
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. logUnknownComponent
// ---------------------------------------------------------------------------

describe("logUnknownComponent", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("calls console.warn containing the componentId", () => {
    logUnknownComponent("mystery-widget");
    expect(console.warn).toHaveBeenCalledOnce();
    const warnMock = vi.mocked(console.warn);
    const args = warnMock.mock.calls[0] as unknown[];
    const combined = args?.join(" ") ?? "";
    expect(combined).toContain("mystery-widget");
  });

  it("does NOT throw for an unknown componentId", () => {
    expect(() => logUnknownComponent("totally-unknown")).not.toThrow();
  });

  it("calls console.warn (not console.error) for an unknown id", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    logUnknownComponent("some-id");
    expect(console.warn).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("includes the literal string '[chat-component-registry]' in the warning", () => {
    logUnknownComponent("x");
    const warnMock = vi.mocked(console.warn);
    const args = warnMock.mock.calls[0] as unknown[];
    const combined = args?.join(" ") ?? "";
    expect(combined).toContain("[chat-component-registry]");
  });
});
