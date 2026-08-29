/**
 * Truth table for the Dispatch-mode routing policy (dispatch-mode.ts).
 *
 * The matrix from docs/specs/repl-async-dispatch.md §2.1, pinned exhaustively:
 * `&` always backgrounds; mode OFF never auto-dispatches; slash/shell and
 * forced-inline `=`/`>` always stay inline; mode ON dispatches every other
 * plain prompt (deterministic — there is no word-match intent heuristic and
 * no "simple"-stays-inline branch; `=` is the inline escape). Pure — no
 * React, no spawn, no store.
 */
import { describe, it, expect } from "vitest";
import { decideDispatch } from "../dispatch-mode.js";

describe("decideDispatch — trailing ` &` (either mode)", () => {
  it("backgrounds a `&`-suffixed prompt with mode OFF, marker stripped", () => {
    expect(decideDispatch("fix the login bug &", { mode: false })).toEqual({
      kind: "background",
      prompt: "fix the login bug",
    });
  });

  it("backgrounds a `&`-suffixed prompt with mode ON, marker stripped", () => {
    expect(decideDispatch("what is the login flow &", { mode: true })).toEqual({
      kind: "background",
      prompt: "what is the login flow",
    });
  });

  it("does not treat a bare `&` as a dispatch", () => {
    expect(decideDispatch("&", { mode: false })).toEqual({
      kind: "inline",
      prompt: "&",
    });
  });

  it("never dispatches a slash command even with a `&` suffix", () => {
    expect(decideDispatch("/model foo &", { mode: true })).toEqual({
      kind: "inline",
      prompt: "/model foo &",
    });
  });
});

describe("decideDispatch — mode OFF leaves everything inline", () => {
  it("keeps a task prompt inline when the mode is off", () => {
    expect(decideDispatch("fix the login bug", { mode: false })).toEqual({
      kind: "inline",
      prompt: "fix the login bug",
    });
  });

  it("keeps a simple prompt inline when the mode is off", () => {
    expect(decideDispatch("what is the login flow?", { mode: false })).toEqual({
      kind: "inline",
      prompt: "what is the login flow?",
    });
  });
});

describe("decideDispatch — mode ON dispatches every plain prompt", () => {
  it("backgrounds an imperative task prompt", () => {
    expect(decideDispatch("fix the login bug", { mode: true })).toEqual({
      kind: "background",
      prompt: "fix the login bug",
    });
  });

  it("backgrounds a conversational lookup (no intent heuristic — `=` is the inline escape)", () => {
    expect(decideDispatch("what is the login flow?", { mode: true })).toEqual({
      kind: "background",
      prompt: "what is the login flow?",
    });
  });

  it("backgrounds a delegated request ('can you add …')", () => {
    expect(
      decideDispatch("can you add rate-limit headers", { mode: true }),
    ).toEqual({ kind: "background", prompt: "can you add rate-limit headers" });
  });

  it("trims surrounding whitespace off a dispatched prompt", () => {
    expect(
      decideDispatch("  audit the billing meters  ", { mode: true }),
    ).toEqual({ kind: "background", prompt: "audit the billing meters" });
  });
});

describe("decideDispatch — mode ON: commands and forced-inline never dispatch", () => {
  it("keeps a slash command inline", () => {
    expect(decideDispatch("/dispatch off", { mode: true })).toEqual({
      kind: "inline",
      prompt: "/dispatch off",
    });
  });

  it("keeps a shell command inline", () => {
    expect(decideDispatch("!git status", { mode: true })).toEqual({
      kind: "inline",
      prompt: "!git status",
    });
  });

  it("forces a task inline with a leading `=`, stripping the marker", () => {
    expect(decideDispatch("= fix the login bug", { mode: true })).toEqual({
      kind: "inline",
      prompt: "fix the login bug",
    });
  });

  it("forces a task inline with a leading `> `, stripping the marker", () => {
    expect(decideDispatch("> rename the module", { mode: true })).toEqual({
      kind: "inline",
      prompt: "rename the module",
    });
  });
});
