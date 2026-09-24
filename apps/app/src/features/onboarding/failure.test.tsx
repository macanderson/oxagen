// @vitest-environment jsdom
// The sentence a refused onboarding write shows: every reason the four bound
// handlers throw has its own sentence, under each of the three refusal kinds
// the kernel can file it as, and any other code is printed as recorded.
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { IntlProvider, translator } from "@/test/intl";
import { UNANSWERED, useOnboardingFailure } from "./failure";

const t = translator("onboarding.register.failure");

function word() {
  return renderHook(useOnboardingFailure, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <IntlProvider>{children}</IntlProvider>
    ),
  }).result.current;
}

const HANDLER_REASONS: readonly (readonly [string, string])[] = [
  ["org_role_required", "orgRoleRequired"],
  ["no_principal", "noPrincipal"],
  ["agent_not_found", "agentNotFound"],
  ["slug_taken", "slugTaken"],
  ["gate_not_found", "gateNotFound"],
  ["already_unlocked", "alreadyUnlocked"],
  ["first_frame_required", "firstFrameRequired"],
  ["github_not_connected", "githubNotConnected"],
  ["repository_not_installed", "repositoryNotInstalled"],
  ["main_repo_bound", "mainRepoBound"],
];

describe("onboarding write refusal", () => {
  it.each(["denied", "not_found", "conflict"] as const)(
    "gives each handler reason its own sentence when filed as %s",
    (reason) => {
      const say = word();
      const sentences = HANDLER_REASONS.map(([code, key]) => {
        const sentence = say({ ok: false, reason, code });
        expect(sentence).toBe(t(key));
        return sentence;
      });
      expect(new Set(sentences).size).toBe(HANDLER_REASONS.length);
    },
  );

  it("prints a code it has no sentence for as recorded (negative)", () => {
    expect(word()({ ok: false, reason: "denied", code: "something_new" })).toBe(
      "The write was refused: something_new. Nothing was changed.",
    );
  });

  it("points an invalid form back at its fields without printing the code (negative)", () => {
    const sentence = word()({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
    });
    expect(sentence).toBe(t("invalid"));
    expect(sentence).not.toContain("invalid_input");
  });

  it("names the access request a write is waiting on", () => {
    expect(
      word()({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_7k2m",
      }),
    ).toBe("The write is waiting for approval, request acr_7k2m.");
  });

  it("prints the code of an exhausted budget and of a write that never answered (negative)", () => {
    const say = word();
    expect(say({ ok: false, reason: "exhausted", code: "gau_exhausted" })).toBe(
      "The write did not complete: gau_exhausted. Nothing was changed.",
    );
    expect(say(UNANSWERED)).toBe(
      "The write did not complete: action_failed. Nothing was changed.",
    );
  });
});
