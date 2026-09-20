import { describe, expect, it } from "vitest";
import { contentClassOf } from "./frame-body";
import {
  narrowestOf,
  RETENTION_CLASS_BY_KIND,
  retainsBody,
  type RetentionMandate,
} from "./retention";

const exact = (classes: string[]): RetentionMandate => ({
  mode: "content_exact",
  classes,
});

describe("retainsBody", () => {
  it("retains worktree patch bytes only under an exact tool-call mandate", () => {
    expect(
      retainsBody("oxagen:worktree_reconciled", exact(["tool_call"])),
    ).toBe(true);
    expect(
      retainsBody("oxagen:worktree_reconciled", exact(["model_call"])),
    ).toBe(false);
    expect(
      retainsBody("oxagen:worktree_reconciled", {
        mode: "digest_only",
        classes: ["tool_call"],
      }),
    ).toBe(false);
    expect(RETENTION_CLASS_BY_KIND["oxagen:worktree_reconciled"]).toBe(
      "tool_call",
    );
  });

  it("keeps nothing under digest_only, whatever the classes say", () => {
    expect(
      retainsBody("turn_start", {
        mode: "digest_only",
        classes: ["model_call"],
      }),
    ).toBe(false);
  });

  it("keeps a frame only when its class is named", () => {
    expect(retainsBody("turn_start", exact(["model_call"]))).toBe(true);
    expect(retainsBody("turn_start", exact(["tool_call"]))).toBe(false);
    expect(retainsBody("tool_call", exact(["tool_call"]))).toBe(true);
  });

  it("keeps nothing when the mandate names no class", () => {
    // `content_exact` says exact bytes MAY be kept. The classes say which.
    // An empty list authorises none of them, and reading the mode alone
    // would keep a prompt for a workspace that asked for no content at all.
    expect(retainsBody("turn_start", exact([]))).toBe(false);
  });

  it("keeps nothing for a kind the table does not name", () => {
    // Frames arrive faster than mandates are rewritten. An unmapped kind
    // failing open would retain content nobody authorised.
    expect(retainsBody("oxagen:notification", exact(["model_call"]))).toBe(
      false,
    );
    expect(retainsBody("", exact(["model_call"]))).toBe(false);
  });

  it("keeps nothing when there is no mandate to read", () => {
    expect(retainsBody("turn_start", undefined)).toBe(false);
  });

  it("names only classes the run ledger's vocabulary defines", () => {
    // `@oxagen/tacho` takes no `@oxagen/*` runtime dependency, so
    // `RETENTION_CONTENT_CLASSES` cannot be imported here. The list is
    // mirrored instead, and this is where the two are held in step: a class
    // this package invents would be authorised by no mandate the control
    // plane can issue, and the body would be written and then refused.
    const vocabulary = new Set([
      "admission_receipt",
      "checkout_receipt",
      "context_selection",
      "model_call",
      "tool_call",
      "approval_receipt",
      "change_receipt",
      "verification_receipt",
      "provider_receipt",
      "terminal_receipt",
    ]);
    for (const [kind, contentClass] of Object.entries(
      RETENTION_CLASS_BY_KIND,
    )) {
      expect(
        vocabulary.has(contentClass),
        `${kind} maps to ${contentClass}, which no mandate can name`,
      ).toBe(true);
    }
  });
});

describe("one table, not two", () => {
  it("retains a body for every kind the host classifies and ships", () => {
    // The host asks `contentClassOf` whether to write a body and the control
    // plane asks `retainsBody` whether to accept one. These were separate
    // tables until one fell behind: the host wrote and shipped bodies for
    // `tool_requested`, `token_denied` and `approval_request`, and the
    // control plane refused all three as `retention_class_excluded`, so a
    // workspace paying for that content lost it and recorded a gap instead.
    const everything = {
      mode: "content_exact",
      classes: ["model_call", "tool_call", "approval_receipt"],
    } as const;
    for (const kind of [
      "turn_start",
      "turn_end",
      "llm_call",
      "oxagen:message",
      "subagent_stop",
      "tool_requested",
      "tool_call",
      "token_denied",
      "approval_request",
    ]) {
      expect(contentClassOf(kind), `${kind} is classified`).toBeDefined();
      expect(retainsBody(kind, everything), `${kind} is retained`).toBe(true);
    }
  });

  it("agrees with the host on the class, not just on retaining something", () => {
    // A kind retained under the wrong class would still ship under a mandate
    // that names every class, and fail under a narrower one.
    for (const kind of Object.keys(RETENTION_CLASS_BY_KIND)) {
      const cls = contentClassOf(kind);
      expect(cls).toBeDefined();
      expect(
        retainsBody(kind, { mode: "content_exact", classes: [cls as string] }),
      ).toBe(true);
      const others = ["model_call", "tool_call", "approval_receipt"].filter(
        (c) => c !== cls,
      );
      expect(
        retainsBody(kind, { mode: "content_exact", classes: others }),
      ).toBe(false);
    }
  });
});

describe("narrowestOf", () => {
  it("keeps only what both mandates keep", () => {
    expect(
      narrowestOf(exact(["model_call", "tool_call"]), exact(["tool_call"])),
    ).toEqual({ mode: "content_exact", classes: ["tool_call"] });
  });

  it("holds a class one mandate drops even when the other picks a class up", () => {
    // The case a host owing an unfinished purge has to survive. One clause
    // dropped tool content, the next drops model content and takes tool
    // content back. Reading the newer clause alone would leave the tool bytes
    // on disk with nothing left that names them.
    expect(narrowestOf(exact(["model_call"]), exact(["tool_call"]))).toEqual({
      mode: "content_exact",
      classes: [],
    });
  });

  it("falls to digest_only when either mandate says so", () => {
    expect(
      narrowestOf(exact(["model_call"]), {
        mode: "digest_only",
        classes: ["model_call"],
      }),
    ).toEqual({ mode: "digest_only", classes: ["model_call"] });
  });
});
