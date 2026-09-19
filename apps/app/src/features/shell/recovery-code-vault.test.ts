// @vitest-environment jsdom
// The vault that holds a freshly issued recovery-code set until it is saved.
// It lives at the page's lifetime, not a component's, so these tests drive the
// module directly and reset it between cases.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { recoveryCodeVault, useRecoveryCodeVault } from "./recovery-code-vault";

const ME = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSE = "22222222-2222-4222-8222-222222222222";

// `dispatchEvent` answers false when a listener cancelled the event, which is
// what the browser reads as "ask before leaving".
const asked = () =>
  !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

beforeEach(() => {
  recoveryCodeVault.resetForTests();
});

describe("recoveryCodeVault", () => {
  it("runs one rotation at a time", () => {
    expect(recoveryCodeVault.begin(ME)).toBe(true);
    expect(recoveryCodeVault.begin(ME)).toBe(false);
    recoveryCodeVault.end();
    expect(recoveryCodeVault.begin(ME)).toBe(true);
  });

  // Better Auth voids the old set when the rotation lands, before the answer
  // arrives, so the prompt is up from the start of the rotation until the
  // returned set is saved.
  it("asks before unloading from the start of a rotation until the set is saved", () => {
    expect(asked()).toBe(false);
    recoveryCodeVault.begin(ME);
    expect(asked()).toBe(true);
    recoveryCodeVault.hold(ME, ["aaaa-1111"]);
    expect(asked()).toBe(true);
    recoveryCodeVault.clear();
    expect(asked()).toBe(false);
  });

  it("shows the held set to the person it was issued to", () => {
    const { result } = renderHook(() => useRecoveryCodeVault(ME));
    act(() => {
      recoveryCodeVault.begin(ME);
    });
    expect(result.current.rotating).toBe(true);
    act(() => {
      recoveryCodeVault.hold(ME, ["aaaa-1111", "bbbb-2222"]);
    });
    expect(result.current).toEqual({
      userId: ME,
      rotating: false,
      codes: ["aaaa-1111", "bbbb-2222"],
      uncertain: false,
    });
  });

  it("never shows it to anyone else (negative)", () => {
    recoveryCodeVault.hold(ME, ["aaaa-1111"]);
    const { result } = renderHook(() => useRecoveryCodeVault(SOMEONE_ELSE));
    expect(result.current).toEqual({
      rotating: false,
      codes: null,
      uncertain: false,
    });
  });

  // The store outlives a sign-out and a sign-in as somebody else in the same
  // tab, and the second person sees nothing held, because the vault hides one
  // person's state from another. A rotation from there used to write over the
  // first person's only plaintext copy of a set the server had already swapped
  // in. They were signed out, so they could not save it first and cannot get
  // it back: that is a locked-out account on the next lost authenticator.
  it("refuses a rotation over another person's unsaved set (negative)", () => {
    recoveryCodeVault.hold(ME, ["aaaa-1111"]);
    expect(recoveryCodeVault.begin(SOMEONE_ELSE)).toBe(false);
    expect(recoveryCodeVault.heldByAnother(SOMEONE_ELSE)).toBe(true);

    // And the first person's set is untouched by the attempt.
    const { result } = renderHook(() => useRecoveryCodeVault(ME));
    expect(result.current.codes).toEqual(["aaaa-1111"]);
  });

  // The same for doubt: a rotation whose answer was lost leaves the stored set
  // unknown, and that state is as much the first person's as a held set is.
  it("refuses a rotation over another person's unresolved rotation (negative)", () => {
    recoveryCodeVault.lose(ME);
    expect(recoveryCodeVault.begin(SOMEONE_ELSE)).toBe(false);
    expect(recoveryCodeVault.heldByAnother(SOMEONE_ELSE)).toBe(true);
    const { result } = renderHook(() => useRecoveryCodeVault(ME));
    expect(result.current.uncertain).toBe(true);
  });

  // Once the first person has saved their set there is nothing to protect, so
  // the next person rotates normally. Refusing for ever would be its own bug.
  it("lets another person rotate once nothing is at stake", () => {
    recoveryCodeVault.hold(ME, ["aaaa-1111"]);
    recoveryCodeVault.clear();
    expect(recoveryCodeVault.heldByAnother(SOMEONE_ELSE)).toBe(false);
    expect(recoveryCodeVault.begin(SOMEONE_ELSE)).toBe(true);
  });

  // Two tabs of one account are two JavaScript realms, so everything above is
  // per-tab: both `begin()` calls answered true, both rotated, and the second
  // commit voided the first tab's set while that tab still showed it under
  // "New recovery codes" with a button saying they are saved. Somebody writes
  // down codes that already do not work.
  describe("across tabs", () => {
    it("refuses to start while another tab is rotating", () => {
      recoveryCodeVault.receiveForTests({ kind: "rotating", userId: ME });
      expect(recoveryCodeVault.rotatingElsewhere()).toBe(true);
      expect(recoveryCodeVault.begin(ME)).toBe(false);
    });

    // Without this, a tab whose rotation was refused would leave every other
    // tab blocked for the life of the page.
    it("starts again once the other tab's rotation has finished", () => {
      recoveryCodeVault.receiveForTests({ kind: "rotating", userId: ME });
      recoveryCodeVault.receiveForTests({ kind: "finished", userId: ME });
      expect(recoveryCodeVault.rotatingElsewhere()).toBe(false);
      expect(recoveryCodeVault.begin(ME)).toBe(true);
    });

    // The set this tab is showing was issued before the other tab's write, so
    // it is void. Showing it as usable is the whole defect; the doubtful state
    // is what is true, since this tab cannot know whether the other one's set
    // was saved.
    it("drops a held set when another tab issues one, and says so", () => {
      recoveryCodeVault.hold(ME, ["aaaa-1111"]);
      recoveryCodeVault.receiveForTests({ kind: "rotated", userId: ME });
      const { result } = renderHook(() => useRecoveryCodeVault(ME));
      expect(result.current.codes).toBeNull();
      expect(result.current.uncertain).toBe(true);
      // And the page stays guarded, because something is still at stake.
      expect(asked()).toBe(true);
    });

    // Another person's rotation says nothing about this one's set.
    it("leaves a held set alone when the other tab is another person (negative)", () => {
      recoveryCodeVault.hold(ME, ["aaaa-1111"]);
      recoveryCodeVault.receiveForTests({
        kind: "rotated",
        userId: SOMEONE_ELSE,
      });
      const { result } = renderHook(() => useRecoveryCodeVault(ME));
      expect(result.current.codes).toEqual(["aaaa-1111"]);
      expect(result.current.uncertain).toBe(false);
    });
  });

  // A second rotation must not drop a set that is still unsaved before the
  // new one has answered.
  it("keeps an unsaved set while a further rotation is on the wire", () => {
    recoveryCodeVault.hold(ME, ["aaaa-1111"]);
    recoveryCodeVault.begin(ME);
    const { result } = renderHook(() => useRecoveryCodeVault(ME));
    expect(result.current.codes).toEqual(["aaaa-1111"]);
  });

  // A lost answer may mean the server already rotated: the old set void, the
  // new one gone. Only a rotation that answers with a set settles it; a
  // refusal answers only for itself.
  it("stays at stake after a lost answer until a set arrives", () => {
    recoveryCodeVault.begin(ME);
    recoveryCodeVault.end();
    recoveryCodeVault.lose(ME);
    expect(asked()).toBe(true);

    recoveryCodeVault.begin(ME);
    recoveryCodeVault.end();
    recoveryCodeVault.refuse();
    expect(asked()).toBe(true);
    const { result } = renderHook(() => useRecoveryCodeVault(ME));
    expect(result.current.uncertain).toBe(true);

    act(() => {
      recoveryCodeVault.hold(ME, ["aaaa-1111"]);
    });
    expect(result.current.uncertain).toBe(false);
    act(() => {
      recoveryCodeVault.clear();
    });
    expect(asked()).toBe(false);
  });

  it("releases after a plain refusal with nothing else outstanding", () => {
    recoveryCodeVault.begin(ME);
    recoveryCodeVault.end();
    recoveryCodeVault.refuse();
    expect(asked()).toBe(false);
  });

  // Another person's session can end elsewhere and a new person sign in within
  // the same page. The first person's unsaved set is hidden from the second,
  // and it is the only copy there is, so the second may not rotate over it.
  it("refuses a rotation while someone else has codes at stake (negative)", () => {
    recoveryCodeVault.hold(ME, ["aaaa-1111"]);
    expect(recoveryCodeVault.begin(SOMEONE_ELSE)).toBe(false);
    const { result } = renderHook(() => useRecoveryCodeVault(ME));
    expect(result.current.codes).toEqual(["aaaa-1111"]);

    act(() => {
      recoveryCodeVault.clear();
      recoveryCodeVault.lose(ME);
    });
    expect(recoveryCodeVault.begin(SOMEONE_ELSE)).toBe(false);
    expect(result.current.uncertain).toBe(true);
  });

  it("lets another person rotate once nothing is at stake", () => {
    recoveryCodeVault.hold(ME, ["aaaa-1111"]);
    recoveryCodeVault.clear();
    expect(recoveryCodeVault.begin(SOMEONE_ELSE)).toBe(true);
  });

  // A refused rotation replaced nothing, so an unsaved set from before it is
  // still the one that works and stays held.
  it("keeps an unsaved set through a refused rotation", () => {
    recoveryCodeVault.hold(ME, ["aaaa-1111"]);
    recoveryCodeVault.begin(ME);
    recoveryCodeVault.end();
    recoveryCodeVault.refuse();
    const { result } = renderHook(() => useRecoveryCodeVault(ME));
    expect(result.current.codes).toEqual(["aaaa-1111"]);
    expect(asked()).toBe(true);
  });
});
