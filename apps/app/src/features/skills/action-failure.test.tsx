// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import messages from "../../../messages/skills.json";
import { translator } from "@/test/intl";
import { UNANSWERED, useSkillFailure } from "./action-failure";

const t = translator("skills.console.failure");

function word() {
  return renderHook(useSkillFailure, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale="en" messages={messages}>
        {children}
      </NextIntlClientProvider>
    ),
  }).result.current;
}

const SKILL_REASONS: readonly (readonly [string, string])[] = [
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
];

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

  it.each(["not_found", "conflict", "unavailable"] as const)(
    "gives each skill handler reason its own sentence when filed as %s",
    (reason) => {
      const say = word();
      const sentences = SKILL_REASONS.map(([code, key]) => {
        const sentence = say({ ok: false, reason, code });
        expect(sentence).toBe(t(key));
        return sentence;
      });
      expect(new Set(sentences).size).toBe(SKILL_REASONS.length);
    },
  );

  it("names a denial by role even when its code is a skill reason (negative)", () => {
    expect(
      word()({ ok: false, reason: "denied", code: "skill_config_missing" }),
    ).toBe(t("denied"));
  });

  it("prints an exhausted budget's code as recorded and keeps the draft (negative)", () => {
    expect(
      word()({ ok: false, reason: "exhausted", code: "budget_exceeded" }),
    ).toBe(
      "The action did not complete (budget_exceeded). Your draft is still here.",
    );
  });
});
