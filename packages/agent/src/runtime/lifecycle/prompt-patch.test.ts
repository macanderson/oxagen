/**
 * prompt-patch.test.ts — unit tests for applyPromptPatch and its JSON-pointer
 * write. The function is the only place a lifecycle plugin's patch touches a
 * turn's prompt, and it had no tests of its own: every operation arm, the
 * pointer escapes, and both missing-path failures are pinned here.
 */
import { describe, expect, it } from "vitest";

import {
  applyPromptPatch,
  PromptPatchError,
  type LifecyclePrompt,
} from "./prompt-patch";

const basePrompt = (): LifecyclePrompt => ({
  system: "SYSTEM",
  user: "USER",
  input: { repo: { name: "oxagen", token: "s3cret" }, "a/b": { "~x": 1 } },
  metadata: { seeded: true },
});

const patch = (...operations: unknown[]) => ({ operations });

describe("applyPromptPatch — content operations", () => {
  it("prepends and appends system and user context in operation order", () => {
    const next = applyPromptPatch(
      basePrompt(),
      patch(
        { op: "prepend_system_context", content: "S-PRE" },
        { op: "append_system_context", content: "S-POST" },
        { op: "prepend_user_context", content: "U-PRE" },
        { op: "append_user_context", content: "U-POST" },
      ),
    );
    expect(next.system).toBe("S-PRE\n\nSYSTEM\n\nS-POST");
    expect(next.user).toBe("U-PRE\n\nUSER\n\nU-POST");
  });

  it("never mutates the prompt it was given", () => {
    const prompt = basePrompt();
    applyPromptPatch(
      prompt,
      patch(
        { op: "append_system_context", content: "X" },
        { op: "redact_input_path", path: "/repo/token" },
        { op: "add_metadata", key: "k", value: 1 },
      ),
    );
    expect(prompt).toEqual(basePrompt());
  });
});

describe("applyPromptPatch — input path operations", () => {
  it("redacts a nested path in place", () => {
    const next = applyPromptPatch(
      basePrompt(),
      patch({ op: "redact_input_path", path: "/repo/token" }),
    );
    expect(next.input).toEqual({
      repo: { name: "oxagen", token: "[REDACTED]" },
      "a/b": { "~x": 1 },
    });
  });

  it("replaces a value at a path", () => {
    const next = applyPromptPatch(
      basePrompt(),
      patch({ op: "replace_input_path", path: "/repo/name", value: "renamed" }),
    );
    expect((next.input as { repo: { name: string } }).repo.name).toBe(
      "renamed",
    );
  });

  it("decodes RFC 6901 escapes: ~1 is '/' and ~0 is '~'", () => {
    const next = applyPromptPatch(
      basePrompt(),
      patch({ op: "replace_input_path", path: "/a~1b/~0x", value: 2 }),
    );
    expect((next.input as Record<string, unknown>)["a/b"]).toEqual({
      "~x": 2,
    });
  });

  it("the whole-document pointer replaces the input outright", () => {
    const next = applyPromptPatch(
      basePrompt(),
      patch({ op: "replace_input_path", path: "/", value: { fresh: true } }),
    );
    expect(next.input).toEqual({ fresh: true });
  });

  it("a missing intermediate segment is invalid_prompt_patch_path", () => {
    expect(() =>
      applyPromptPatch(
        basePrompt(),
        patch({ op: "redact_input_path", path: "/nope/deeper" }),
      ),
    ).toThrowError(
      new PromptPatchError(
        "invalid_prompt_patch_path",
        "missing path /nope/deeper",
      ),
    );
  });

  it("a missing final segment is invalid_prompt_patch_path", () => {
    expect(() =>
      applyPromptPatch(
        basePrompt(),
        patch({ op: "redact_input_path", path: "/repo/nope" }),
      ),
    ).toThrowError(PromptPatchError);
  });
});

describe("applyPromptPatch — metadata, rejection, and validation", () => {
  it("add_metadata writes the key without dropping existing ones", () => {
    const next = applyPromptPatch(
      basePrompt(),
      patch({ op: "add_metadata", key: "actor", value: "plugin" }),
    );
    expect(next.metadata).toEqual({ seeded: true, actor: "plugin" });
  });

  it("reject_turn throws the plugin's own code and message", () => {
    let thrown: unknown;
    try {
      applyPromptPatch(
        basePrompt(),
        patch({ op: "reject_turn", code: "policy_denied", message: "no" }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PromptPatchError);
    expect((thrown as PromptPatchError).code).toBe("policy_denied");
    expect((thrown as PromptPatchError).message).toBe("policy_denied: no");
  });

  it("a patch that fails the schema never reaches the prompt", () => {
    expect(() =>
      applyPromptPatch(basePrompt(), patch({ op: "not_an_op" })),
    ).toThrow();
    expect(() => applyPromptPatch(basePrompt(), { nope: true })).toThrow();
  });

  it("an empty operations list is a no-op", () => {
    expect(applyPromptPatch(basePrompt(), patch())).toEqual(basePrompt());
  });
});
