// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountOperations,
  useAccountExport,
  useAccountOperation,
} from "./account-operations";

beforeEach(() => {
  accountOperations.resetForTests();
});

describe("account operation lifetime", () => {
  it.each(["profile", "preferences", "avatar"] as const)(
    "holds %s across panel remounts",
    (operation) => {
      const first = renderHook(() => useAccountOperation("user-a", operation));
      act(() => {
        expect(first.result.current.begin()).toBe(true);
      });
      first.unmount();
      const second = renderHook(() => useAccountOperation("user-a", operation));
      expect(second.result.current.pending).toBe(true);
      act(() => {
        expect(second.result.current.begin()).toBe(false);
      });
      act(() => {
        accountOperations.end("user-a", operation);
      });
      expect(second.result.current.pending).toBe(false);
      act(() => {
        expect(second.result.current.begin()).toBe(true);
      });
      act(() => {
        second.result.current.end();
      });
    },
  );

  it("keeps accounts and operation kinds separate", () => {
    expect(accountOperations.begin("user-a", "profile")).toBe(true);
    expect(accountOperations.begin("user-b", "profile")).toBe(true);
    expect(accountOperations.begin("user-a", "avatar")).toBe(true);
  });

  it("retains an export accepted after its requesting panel unmounts", () => {
    const first = renderHook(() => useAccountExport("user-a", "acme"));
    act(() => {
      expect(first.result.current.begin("user")).toBe(true);
    });
    const settle = first.result.current.setState;
    first.unmount();
    settle({ kind: "queued", scope: "user", exportId: "export-a" });
    const second = renderHook(() => useAccountExport("user-a", "acme"));
    expect(second.result.current.state).toEqual({
      kind: "queued",
      scope: "user",
      exportId: "export-a",
    });
    act(() => {
      expect(second.result.current.begin("org")).toBe(false);
    });
    expect(accountOperations.readExport("user-b", "acme")).toEqual({
      kind: "idle",
    });
    expect(accountOperations.readExport("user-a", "other")).toEqual({
      kind: "idle",
    });
  });
});
