import { describe, expect, it } from "vitest";
import {
  RETENTION_CLASS_BY_KIND,
  retainsBody,
  type RetentionMandate,
} from "./retention";

const exact = (classes: string[]): RetentionMandate => ({
  mode: "content_exact",
  classes,
});

describe("retainsBody", () => {
  it("keeps no bytes for a worktree reconciliation, at any mandate", () => {
    // The frame carries file paths, and a path is not content in the sense
    // this mandate governs: `tool_target` has always travelled on the body
    // of a `file_io` frame under `digest_only`, and the observed list is the
    // same class of fact read from git rather than from a tool. What the
    // mandate governs is the exact BYTES of a prompt, a response or a tool
    // result, which this frame has none of. It maps to no content class, so
    // it retains nothing whatever the mandate says, and there is nothing for
    // it to retain.
    expect(
      retainsBody("oxagen:worktree_reconciled", exact(["tool_call"])),
    ).toBe(false);
    expect(
      retainsBody(
        "oxagen:worktree_reconciled",
        exact(["model_call", "tool_call", "change_receipt"]),
      ),
    ).toBe(false);
    expect(RETENTION_CLASS_BY_KIND["oxagen:worktree_reconciled"]).toBeUndefined();
  });

  it("keeps nothing under digest_only, whatever the classes say", () => {
    expect(
      retainsBody("turn_start", { mode: "digest_only", classes: ["model_call"] }),
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
