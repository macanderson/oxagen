// @vitest-environment jsdom
// Every refusal an onboarding write can meet has its own sentence: each reason
// register_agent, create_enrollment_token, advance_onboarding and
// bind_main_repository throw, and the kernel's classifications. Any other code
// is printed as recorded. Expected sentences are read from the real catalogue,
// so a test fails when a code is routed to the wrong sentence, not when the
// copy is reworded.
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { IntlProvider, messages, translator } from "@/test/intl";
import {
  type OnboardingFailure,
  UNANSWERED,
  useOnboardingFailure,
} from "./failure";

const intl = ({ children }: { children: ReactNode }) => (
  <IntlProvider>{children}</IntlProvider>
);

function sentence(failure: OnboardingFailure): string {
  const { result } = renderHook(() => useOnboardingFailure(), {
    wrapper: intl,
  });
  return result.current(failure);
}

const expected = translator("onboarding.register.failure");

// The three kernel classifications that carry a handler reason in `code`.
const CODED = ["denied", "not_found", "conflict"] as const;

const HANDLER_REASONS = [
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
] as const;

describe("useOnboardingFailure", () => {
  it("has a distinct sentence for every key, so each mapping below discriminates", () => {
    const sentences = Object.values(messages.onboarding.register.failure);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  describe.each(CODED)("a %s refusal", (reason) => {
    it.each(HANDLER_REASONS)("names %s with its own sentence", (code, key) => {
      expect(sentence({ ok: false, reason, code })).toBe(expected(key));
    });

    it("prints an unrecognised code as recorded and says nothing changed", () => {
      expect(sentence({ ok: false, reason, code: "quota_frozen" })).toBe(
        "The write was refused: quota_frozen. Nothing was changed.",
      );
    });
  });

  it("names a taken slug so the person can pick another", () => {
    expect(
      sentence({ ok: false, reason: "conflict", code: "slug_taken" }),
    ).toBe("An agent in this workspace already holds that slug. Pick another.");
  });

  it("answers a refused form with one sentence, even when the code is a handler reason", () => {
    const text =
      "The form was refused before the write ran. Check the fields above.";
    expect(sentence({ ok: false, reason: "invalid", code: "x" })).toBe(text);
    expect(
      sentence({
        ok: false,
        reason: "invalid",
        code: "slug_taken",
        field: "slug",
      }),
    ).toBe(text);
  });

  it("names the access request a parked write waits on", () => {
    expect(
      sentence({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "ar_9",
      }),
    ).toBe("The write is waiting for approval, request ar_9.");
  });

  it.each(["gau_exhausted", "billing_suspended", "budget_exceeded"] as const)(
    "reports an exhausted %s as not completed with its code",
    (code) => {
      expect(sentence({ ok: false, reason: "exhausted", code })).toBe(
        `The write did not complete: ${code}. Nothing was changed.`,
      );
    },
  );

  it("prints an unavailable code as recorded, even when it is a handler reason", () => {
    expect(
      sentence({ ok: false, reason: "unavailable", code: "slug_taken" }),
    ).toBe("The write did not complete: slug_taken. Nothing was changed.");
  });

  it("names a write that threw before it answered as action_failed", () => {
    expect(UNANSWERED).toEqual({
      ok: false,
      reason: "unavailable",
      code: "action_failed",
    });
    expect(sentence(UNANSWERED)).toBe(
      "The write did not complete: action_failed. Nothing was changed.",
    );
  });
});
