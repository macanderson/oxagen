// @vitest-environment jsdom
// The one draft of an agent's file (draft-store.ts), shared by the form and
// the source editor through sessionStorage: a draft survives a remount, a
// draft made against a base that has since changed is dropped, a stored value
// this module did not write reads as no draft, and a browser that refuses
// storage keeps the draft in the tab's memory instead. No component renders
// here, only the hook, so there is nothing for axe to read.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDefinitionDraft } from "./draft-store";

const KEY = "oxagen.agent-draft.release-bot";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function useDraftOf({ a, b }: { a: string; b: string }) {
  return useDefinitionDraft(a, b);
}

function renderDraft(agent = "release-bot", base = "base") {
  return renderHook(useDraftOf, {
    initialProps: { a: agent, b: base },
  });
}

describe("useDefinitionDraft", () => {
  it("opens on the base, stores an edit against it, and clears the store when the edit returns to the base", () => {
    const { result } = renderDraft();
    expect(result.current[0]).toBe("base");
    act(() => {
      result.current[1]("edited");
    });
    expect(result.current[0]).toBe("edited");
    expect(JSON.parse(window.sessionStorage.getItem(KEY) ?? "null")).toEqual({
      base: "base",
      draft: "edited",
    });
    act(() => {
      result.current[1]((current) => `${current} twice`);
    });
    expect(result.current[0]).toBe("edited twice");
    act(() => {
      result.current[1]("base");
    });
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(result.current[0]).toBe("base");
  });

  it("drops a draft made against a base that has since changed (negative)", () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ base: "old", draft: "stale edit" }),
    );
    const { result } = renderDraft("release-bot", "new");
    expect(result.current[0]).toBe("new");
    // An updater starts from the new base, not from the stale draft.
    act(() => {
      result.current[1]((current) => `${current}!`);
    });
    expect(result.current[0]).toBe("new!");
  });

  it.each([
    ["text that is not JSON", "{not json"],
    ["JSON of the wrong shape", JSON.stringify({ base: "base" })],
    [
      "a draft that is not a string",
      JSON.stringify({ base: "base", draft: 4 }),
    ],
    ["JSON null", "null"],
  ])("reads %s as no draft (negative)", (_, raw) => {
    window.sessionStorage.setItem(KEY, raw);
    const { result } = renderDraft();
    expect(result.current[0]).toBe("base");
  });

  it("keeps the draft in this tab's memory when the browser refuses storage", () => {
    const refuse = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(refuse);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(refuse);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(refuse);
    const { result } = renderDraft("memory-bot");
    expect(result.current[0]).toBe("base");
    act(() => {
      result.current[1]("kept in memory");
    });
    expect(result.current[0]).toBe("kept in memory");
    // Another hook on the same agent reads the same memory.
    const other = renderDraft("memory-bot");
    expect(other.result.current[0]).toBe("kept in memory");
    act(() => {
      result.current[1]("base");
    });
    expect(result.current[0]).toBe("base");
  });
});
