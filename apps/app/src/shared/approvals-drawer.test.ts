// @vitest-environment jsdom
// The event a page opens the shell's approvals drawer with, so a page never
// imports the shell: a subscriber hears every open until it unsubscribes.
import { describe, expect, it, vi } from "vitest";
import { openApprovals, subscribeApprovals } from "./approvals-drawer";

describe("approvals drawer event", () => {
  it("calls every subscriber once per openApprovals()", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeApprovals(a);
    const offB = subscribeApprovals(b);
    openApprovals();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    offA();
    offB();
  });

  it("stops calling a subscriber once it unsubscribes (negative)", () => {
    const open = vi.fn();
    const off = subscribeApprovals(open);
    off();
    openApprovals();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not hear an unrelated window event (negative)", () => {
    const open = vi.fn();
    const off = subscribeApprovals(open);
    window.dispatchEvent(new Event("oxagen:open-notifications"));
    expect(open).not.toHaveBeenCalled();
    off();
  });
});
