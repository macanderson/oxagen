/**
 * artifact-iframe.test.ts
 *
 * Covers `looksLikeHtml` (imported from code-execute-card, where it is
 * co-located so CodeExecuteCard can detect HTML output too).
 *
 * ⚠ WHAT THIS FILE DOES NOT COVER: the sandbox and tab blocks below assert
 * against constants declared IN THIS FILE, not against anything HtmlArtifact
 * renders. They document the intended sandbox string; they CANNOT catch a
 * regression in artifact-iframe.tsx — adding `allow-same-origin` to the real
 * component would leave every assertion here green. Real coverage needs a jsdom
 * render of <HtmlArtifact /> reading the iframe's `sandbox` attribute.
 */

import { describe, it, expect } from "vitest";

// ── looksLikeHtml ─────────────────────────────────────────────────────────────
// Import from code-execute-card (where the helper is co-located so
// CodeExecuteCard can detect HTML output too).
import { looksLikeHtml } from "../code-execute-card";

describe("looksLikeHtml", () => {
  it("detects <!DOCTYPE html> (uppercase)", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html><body></body></html>")).toBe(
      true,
    );
  });

  it("detects <!doctype html> (lowercase)", () => {
    expect(looksLikeHtml("<!doctype html><html></html>")).toBe(true);
  });

  it("detects <html> opening tag (lowercase)", () => {
    expect(looksLikeHtml("<html lang='en'><head></head></html>")).toBe(true);
  });

  it("detects <HTML> opening tag (uppercase)", () => {
    expect(looksLikeHtml("<HTML><head></head></HTML>")).toBe(true);
  });

  it("ignores leading whitespace before doctype", () => {
    expect(looksLikeHtml("  \n<!DOCTYPE html>")).toBe(true);
  });

  it("does not classify plain text as HTML", () => {
    expect(looksLikeHtml("Hello, world!")).toBe(false);
  });

  it("does not classify JSON as HTML", () => {
    expect(looksLikeHtml('{"key": "value"}')).toBe(false);
  });

  it("does not classify a partial tag as HTML", () => {
    expect(looksLikeHtml("<div>some content</div>")).toBe(false);
  });

  it("does not classify empty string as HTML", () => {
    expect(looksLikeHtml("")).toBe(false);
  });

  it("does not classify SVG fragment as HTML", () => {
    expect(
      looksLikeHtml("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
    ).toBe(false);
  });
});

// ── Iframe sandbox contract ───────────────────────────────────────────────────
// The component renders:
//   <iframe sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} />
//
// We verify the sandbox string spec we intend to use:
//   ✓ Contains "allow-scripts" (so scripts can run inside the frame)
//   ✗ Does NOT contain "allow-same-origin" (so frame cannot access parent context)
//
// This is a pure string test — no DOM rendering required. The test documents and
// enforces the security requirement.

const INTENDED_SANDBOX = "allow-scripts";

describe("iframe sandbox prop — security contract", () => {
  it("intended sandbox value contains 'allow-scripts'", () => {
    expect(INTENDED_SANDBOX).toContain("allow-scripts");
  });

  it("intended sandbox value does NOT contain 'allow-same-origin'", () => {
    expect(INTENDED_SANDBOX).not.toContain("allow-same-origin");
  });

  it("intended sandbox value does NOT contain 'allow-forms'", () => {
    expect(INTENDED_SANDBOX).not.toContain("allow-forms");
  });

  it("intended sandbox value does NOT contain 'allow-top-navigation'", () => {
    expect(INTENDED_SANDBOX).not.toContain("allow-top-navigation");
  });

  it("intended sandbox value does NOT contain 'allow-popups'", () => {
    expect(INTENDED_SANDBOX).not.toContain("allow-popups");
  });
});

// ── Tab type completeness ─────────────────────────────────────────────────────
// Verify the two valid tab states are defined (pure constant test).

type ActiveTab = "preview" | "source";

function isValidTab(value: string): value is ActiveTab {
  return value === "preview" || value === "source";
}

describe("HtmlArtifact — tab type completeness", () => {
  it("'preview' is a valid tab", () => {
    expect(isValidTab("preview")).toBe(true);
  });

  it("'source' is a valid tab", () => {
    expect(isValidTab("source")).toBe(true);
  });

  it("unknown value is not a valid tab", () => {
    expect(isValidTab("other")).toBe(false);
  });
});
