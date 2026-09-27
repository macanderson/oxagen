/**
 * The root `prepare` script installs lefthook's hooks only where hooks are on.
 * A machine that sets `LEFTHOOK=0` or `HUSKY=0` keeps `.git/hooks` empty
 * through every install.
 */
import { describe, expect, it } from "vitest";
import { shouldInstallHooks } from "./install-git-hooks.mjs";

describe("shouldInstallHooks", () => {
  it("installs when neither switch is set", () => {
    expect(shouldInstallHooks({})).toBe(true);
  });

  it("skips when LEFTHOOK is 0 or false", () => {
    expect(shouldInstallHooks({ LEFTHOOK: "0" })).toBe(false);
    expect(shouldInstallHooks({ LEFTHOOK: "false" })).toBe(false);
    expect(shouldInstallHooks({ LEFTHOOK: "FALSE" })).toBe(false);
  });

  it("skips when HUSKY is 0", () => {
    expect(shouldInstallHooks({ HUSKY: "0" })).toBe(false);
  });

  it("installs when a switch holds any other value", () => {
    expect(shouldInstallHooks({ LEFTHOOK: "1", HUSKY: "1" })).toBe(true);
  });
});
