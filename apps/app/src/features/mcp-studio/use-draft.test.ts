// @vitest-environment jsdom
// The Studio draft's store (#4678): one sessionStorage key per server, shared
// by every hook on the page, and kept in memory when the browser refuses
// storage.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftOp } from "./draft";
import { draftKey, idDraftKey, seedDraft } from "./studio.builders";
import { useStudioDraft } from "./use-draft";

const IMPORT: DraftOp = { kind: "import", tool: "create_refund" };
const REMOVE: DraftOp = { kind: "remove", tool: "list_customers" };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("useStudioDraft", () => {
  it("stages under the server's folder name and shares the draft", () => {
    const first = renderHook(() =>
      useStudioDraft({ serverName: "stripe", serverId: "mcs_01k5s1" }),
    );
    const second = renderHook(() =>
      useStudioDraft({ serverName: "stripe", serverId: "mcs_01k5s1" }),
    );
    let staged = false;
    act(() => {
      staged = first.result.current.stage(IMPORT);
    });
    expect(staged).toBe(true);
    expect(second.result.current.ops).toEqual([IMPORT]);
    expect(window.sessionStorage.getItem(draftKey("stripe"))).toBe(
      JSON.stringify({ revision: 0, ops: [IMPORT] }),
    );
  });

  it("keys a server with no folder name by its registry id", () => {
    const { result } = renderHook(() =>
      useStudioDraft({ serverName: null, serverId: "mcs_01k5s2" }),
    );
    act(() => {
      result.current.stage(IMPORT);
    });
    expect(window.sessionStorage.getItem(idDraftKey("mcs_01k5s2"))).not.toBeNull();
    expect(window.sessionStorage.getItem(draftKey("github"))).toBeNull();
  });

  it("reads a stored draft and its revision", () => {
    seedDraft(draftKey("billing"), { revision: 4, ops: [IMPORT, REMOVE] });
    const { result } = renderHook(() =>
      useStudioDraft({ serverName: "billing", serverId: "mcs_01k5s3" }),
    );
    expect(result.current.revision).toBe(4);
    expect(result.current.ops).toEqual([IMPORT, REMOVE]);
  });

  it("refuses an edit that would break the draft", () => {
    const { result } = renderHook(() =>
      useStudioDraft({ serverName: "stripe", serverId: "mcs_01k5s1" }),
    );
    let staged = true;
    act(() => {
      staged = result.current.stage({
        kind: "classify",
        tool: "create_refund",
        risk: "high",
        sideEffect: "write",
        egress: "third_party",
        impacts: ["Not A Tag"],
      });
    });
    expect(staged).toBe(false);
    expect(result.current.ops).toEqual([]);
  });

  it("unstages one edit, discards the rest, and keeps the revision", () => {
    seedDraft(draftKey("billing"), { revision: 2, ops: [IMPORT, REMOVE] });
    const { result } = renderHook(() =>
      useStudioDraft({ serverName: "billing", serverId: "mcs_01k5s3" }),
    );
    act(() => {
      result.current.unstage(0);
    });
    expect(result.current.ops).toEqual([REMOVE]);
    act(() => {
      result.current.discard();
    });
    expect(result.current.ops).toEqual([]);
    expect(result.current.revision).toBe(2);
    act(() => {
      result.current.replace({ revision: 5, ops: [IMPORT] });
    });
    expect(result.current.revision).toBe(5);
    expect(result.current.ops).toEqual([IMPORT]);
  });

  it("removes the key once a never-saved draft is empty", () => {
    const { result } = renderHook(() =>
      useStudioDraft({ serverName: "stripe", serverId: "mcs_01k5s1" }),
    );
    act(() => {
      result.current.stage(IMPORT);
    });
    act(() => {
      result.current.discard();
    });
    expect(window.sessionStorage.getItem(draftKey("stripe"))).toBeNull();
  });

  it("keeps the draft in memory when the browser refuses storage", () => {
    const refuse = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(refuse);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(refuse);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(refuse);
    const { result } = renderHook(() =>
      useStudioDraft({ serverName: "scratch", serverId: "mcs_01k5s4" }),
    );
    act(() => {
      result.current.stage(IMPORT);
    });
    expect(result.current.ops).toEqual([IMPORT]);
    act(() => {
      result.current.discard();
    });
    expect(result.current.ops).toEqual([]);
  });
});
