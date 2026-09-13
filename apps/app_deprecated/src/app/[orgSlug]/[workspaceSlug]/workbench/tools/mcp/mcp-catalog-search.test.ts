// @vitest-environment jsdom
/**
 * mcp-catalog-search.test.ts — unit tests for the pure isRemoteInstallable
 * helper exported by mcp-catalog-search.tsx.
 *
 * Only remote-capable catalog entries are installable from the MCP Servers
 * page: package-only (stdio) registry entries have no hosted endpoint to
 * connect to, so they get a "No hosted endpoint" badge instead of Install.
 *
 * No component mount — pure function only. (jsdom env because importing the
 * module pulls in client-component neighbours like next/image.)
 */

import { describe, it, expect } from "vitest";
import { isRemoteInstallable } from "./mcp-catalog-search";

describe("isRemoteInstallable", () => {
  it("returns true for streamable-http", () => {
    expect(isRemoteInstallable(["streamable-http"])).toBe(true);
  });

  it("returns true for sse", () => {
    expect(isRemoteInstallable(["sse"])).toBe(true);
  });

  it("returns true for plain http", () => {
    expect(isRemoteInstallable(["http"])).toBe(true);
  });

  it("returns false for stdio-only entries", () => {
    expect(isRemoteInstallable(["stdio"])).toBe(false);
  });

  it("returns false for an empty transport list", () => {
    expect(isRemoteInstallable([])).toBe(false);
  });

  it("returns true when any transport is remote (mixed list)", () => {
    expect(isRemoteInstallable(["stdio", "streamable-http"])).toBe(true);
    expect(isRemoteInstallable(["sse", "stdio"])).toBe(true);
  });

  it("returns false for unknown transports", () => {
    expect(isRemoteInstallable(["websocket"])).toBe(false);
  });
});
