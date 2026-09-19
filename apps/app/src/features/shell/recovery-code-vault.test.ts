// @vitest-environment jsdom
// The vault that holds a freshly issued recovery-code set until it is saved.
// It lives at the page's lifetime, not a component's, so these tests drive the
// module directly and reset it between cases.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  recoveryCodeVault,
  resetRecoveryCodeVaultForTests,
  useRecoveryCodeVault,
} from "./recovery-code-vault";

const ME = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSE = "22222222-2222-4222-8222-222222222222";

// `dispatchEvent` answers false when a listener cancelled the event, which is
// what the browser reads as "ask before leaving".
const asked = () =>
  !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

beforeEach(() => {
  resetRecoveryCodeVaultForTests();
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
