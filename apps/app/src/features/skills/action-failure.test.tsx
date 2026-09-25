// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import messages from "../../../messages/skills.json";
import type { ActionResult } from "@/server/kernel";
import { IntlProvider, translator } from "@/test/intl";
import { UNANSWERED, useSkillFailure } from "./action-failure";

describe("skill action refusal", () => {
  it("names role, approval, input and remote failure without discarding drafts", () => {
    const { result } = renderHook(useSkillFailure, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="en" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
    });
    expect(
      result.current({ ok: false, reason: "denied", code: "forbidden" }),
    ).toContain("owner or admin");
    expect(
      result.current({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_123",
      }),
    ).toContain("acr_123");
    expect(
      result.current({ ok: false, reason: "invalid", code: "invalid" }),
    ).toContain("Check the configuration");
    expect(result.current(UNANSWERED)).toContain("action_failed");
  });

  it("names the stale pull request and the way out of a superseded publication", () => {
    const { result } = renderHook(useSkillFailure, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="en" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
    });
    expect(
      result.current({
        ok: false,
        reason: "conflict",
        code: "skill_config_superseded",
      }),
    ).toBe(
      "The production configuration changed after that pull request merged. Publish the pull request that carries the current configuration.",
    );
    expect(
      result.current({
        ok: false,
        reason: "conflict",
        code: "skill_config_pr_unrelated",
      }),
    ).toContain(".oxagen/skills.toml");
  });
});

// Every branch of the mapping, one case per route. A role refusal, a parked
// write and a refused form each have one sentence whatever their code; every
// other classification is routed by the handler's reason, and an unknown
// reason is printed as recorded with the draft kept. Expected sentences are
// read from the real catalogue, so a case fails when a code is routed to the
// wrong sentence, not when the copy is reworded.
type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

const intl = ({ children }: { children: ReactNode }) => (
  <IntlProvider>{children}</IntlProvider>
);

function sentence(failure: Failure): string {
  const { result } = renderHook(() => useSkillFailure(), { wrapper: intl });
  return result.current(failure);
}

const expected = translator("skills.console.failure");

const HANDLER_REASONS = [
  ["skill_config_invalid", "invalidConfig"],
  ["skill_config_not_merged", "notMerged"],
  ["skill_config_pr_unrelated", "unrelatedPr"],
  ["skill_config_superseded", "superseded"],
  ["skill_repository_unbound", "repositoryMissing"],
  ["skill_repository_changed", "repositoryChanged"],
  ["skill_repository_identity_changed", "identityChanged"],
  ["skill_production_branch_missing", "branchMissing"],
  ["skill_config_already_imported", "alreadyImported"],
  ["skill_config_digest_changed", "digestChanged"],
  ["skill_config_missing", "missingVersion"],
  ["skill_catalog_invalid", "catalogInvalid"],
  ["skill_catalog_too_large", "catalogTooLarge"],
  ["skill_catalog_unsafe", "catalogUnsafe"],
] as const;

// Every classification that falls through to the handler-reason switch.
const ROUTED = ["not_found", "conflict", "unavailable"] as const;

describe("useSkillFailure", () => {
  it("has a distinct sentence for every key, so each mapping below discriminates", () => {
    const sentences = Object.values(messages.skills.console.failure);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("answers every role refusal with one sentence, even when the code is a skill reason", () => {
    const text =
      "Your role does not allow this action. Ask an organization owner or admin for access.";
    expect(sentence({ ok: false, reason: "denied", code: "forbidden" })).toBe(
      text,
    );
    expect(
      sentence({ ok: false, reason: "denied", code: "skill_config_invalid" }),
    ).toBe(text);
  });

  it("names the access request a parked write waits on", () => {
    expect(
      sentence({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "ar_7",
      }),
    ).toBe("Access request ar_7 is waiting for approval.");
  });

  it("answers a refused form with one sentence, even when the code is a skill reason", () => {
    const text = expected("invalid");
    expect(sentence({ ok: false, reason: "invalid", code: "x" })).toBe(text);
    expect(
      sentence({
        ok: false,
        reason: "invalid",
        code: "skill_catalog_too_large",
        field: "query",
      }),
    ).toBe(text);
  });

  describe.each(ROUTED)("a %s failure", (reason) => {
    it.each(HANDLER_REASONS)("names %s with its own sentence", (code, key) => {
      expect(sentence({ ok: false, reason, code })).toBe(expected(key));
    });

    it("prints an unrecognised code as recorded and says the draft is kept", () => {
      expect(sentence({ ok: false, reason, code: "quota_frozen" })).toBe(
        "The action did not complete (quota_frozen). Your draft is still here.",
      );
    });
  });

  it.each(["gau_exhausted", "billing_suspended", "budget_exceeded"] as const)(
    "prints an exhausted %s as recorded",
    (code) => {
      expect(sentence({ ok: false, reason: "exhausted", code })).toBe(
        `The action did not complete (${code}). Your draft is still here.`,
      );
    },
  );

  it("names a write that threw before it answered as action_failed", () => {
    expect(UNANSWERED).toEqual({
      ok: false,
      reason: "unavailable",
      code: "action_failed",
    });
    expect(sentence(UNANSWERED)).toBe(
      "The action did not complete (action_failed). Your draft is still here.",
    );
  });
});
