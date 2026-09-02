/**
 * code-execute-card.test.ts
 *
 * Tests for the exported pure helper from code-execute-card.tsx:
 *   - looksLikeHtml: heuristic to detect HTML in stdout
 */

import { describe, it, expect } from "vitest";
import { looksLikeHtml } from "./code-execute-card";

describe("looksLikeHtml", () => {
  it("returns true for a standard DOCTYPE declaration", () => {
    expect(looksLikeHtml("<!DOCTYPE html>\n<html><body></body></html>")).toBe(
      true,
    );
  });

  it("returns true for lowercase doctype", () => {
    expect(looksLikeHtml("<!doctype html>\n<html></html>")).toBe(true);
  });

  it("returns true for <html> opening tag", () => {
    expect(looksLikeHtml("<html lang='en'><head></head></html>")).toBe(true);
  });

  it("returns true for <HTML> uppercase opening tag", () => {
    expect(looksLikeHtml("<HTML><head></head></HTML>")).toBe(true);
  });

  it("returns true when there is leading whitespace before doctype", () => {
    expect(looksLikeHtml("   <!DOCTYPE html><html></html>")).toBe(true);
  });

  it("returns true when there is a newline before doctype", () => {
    expect(looksLikeHtml("\n<!DOCTYPE html><html></html>")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(looksLikeHtml("Hello world")).toBe(false);
  });

  it("returns false for JSON output", () => {
    expect(looksLikeHtml('{"key": "value"}')).toBe(false);
  });

  it("returns false for a partial HTML fragment without doctype or <html> tag", () => {
    expect(looksLikeHtml("<div>Hello</div>")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(looksLikeHtml("")).toBe(false);
  });

  it("returns false for whitespace only", () => {
    expect(looksLikeHtml("   \n\t  ")).toBe(false);
  });
});
