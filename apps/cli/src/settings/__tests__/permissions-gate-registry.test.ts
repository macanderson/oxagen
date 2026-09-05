/**
 * permissions-gate-registry.test.ts — Guards `CANONICAL` (permissions-gate.ts)
 * against drifting from the tools the engine actually registers.
 *
 * `buildWorkspaceTools` (`@oxagen/agent-engine`) is the one place local tools
 * are built. This test calls it for real — with a workspace that implements
 * every optional capability (`MemoryWorkspace` implements `deleteFile`) and an
 * `askUser` callback supplied — so the returned tool set is the full surface
 * a live agent can advertise, and diffs it against `CANONICAL`'s keys both
 * ways: a tool with no row would keep its own raw name and silently skip any
 * rule written against its canonical word (issue #2607); a row for a tool
 * that no longer exists is exactly as stale as the `glob`/`grep`/`code_graph`
 * entries that issue found.
 */
import { describe, it, expect } from "vitest";
import { buildWorkspaceTools, MemoryWorkspace } from "@oxagen/agent-engine";
import { CANONICAL } from "../permissions-gate.js";

describe("permissions-gate CANONICAL table", () => {
  it("has exactly one row per tool buildWorkspaceTools can register", () => {
    const tools = buildWorkspaceTools(new MemoryWorkspace(), {
      askUser: async () => ({ answer: "", wasFreeText: false }),
    });
    const registered = new Set(Object.keys(tools));
    const mapped = new Set(Object.keys(CANONICAL));

    const unmapped = [...registered].filter((name) => !mapped.has(name));
    const stale = [...mapped].filter((name) => !registered.has(name));

    expect(
      unmapped,
      `registered tool(s) with no CANONICAL row (would silently keep their ` +
        `own name and skip any rule written against a canonical word): ` +
        `${unmapped.join(", ")}`,
    ).toEqual([]);
    expect(
      stale,
      `CANONICAL row(s) for a tool that no longer exists: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});
