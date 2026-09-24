// @vitest-environment jsdom
// Every refusal a mandate write can meet has its own sentence: each reason the
// two bound handlers throw, the action's own time-zone refusal, and the
// kernel's classifications. Any other code is printed as recorded, with no
// cause invented for it. Expected sentences are read from the real catalogue,
// so a test fails when a code is routed to the wrong sentence, not when the
// copy is reworded.
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { IntlProvider, messages, translator } from "@/test/intl";
import {
  type ActionFailure,
  UNANSWERED,
  useActionFailure,
} from "./action-failure";

const intl = ({ children }: { children: ReactNode }) => (
  <IntlProvider>{children}</IntlProvider>
);

function sentence(failure: ActionFailure): string {
  const { result } = renderHook(() => useActionFailure(), { wrapper: intl });
  return result.current(failure);
}

const expected = translator("mandate.actions.failure");

// The three kernel classifications that carry a handler reason in `code`.
const CODED = ["denied", "not_found", "conflict"] as const;

const HANDLER_REASONS = [
  ["org_role_required", "orgRoleRequired"],
  ["no_role_covers_all_tags", "noRoleCoversAllTags"],
  ["mandate_not_found", "mandateNotFound"],
  ["mandate_ended", "mandateEnded"],
  ["validity_inverted", "validityInverted"],
  ["no_tool_matches", "noToolMatches"],
  ["measure_not_declared", "measureNotDeclared"],
  ["measure_unit_mismatch", "measureUnitMismatch"],
  ["measure_kind_conflict", "measureKindConflict"],
  ["period_drawn", "periodDrawn"],
  ["measure_kind_drawn", "measureKindDrawn"],
  ["no_principal", "noPrincipal"],
  ["agent_retired", "agentRetired"],
  ["time_zone_unsupported", "timeZoneUnsupported"],
] as const;

describe("useActionFailure", () => {
  it("has a distinct sentence for every key, so each mapping below discriminates", () => {
    const sentences = Object.values(messages.mandate.actions.failure);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  describe.each(CODED)("a %s refusal", (reason) => {
    it.each(HANDLER_REASONS)("names %s with its own sentence", (code, key) => {
      expect(sentence({ ok: false, reason, code })).toBe(expected(key));
    });

    it("prints an unrecognised code as recorded and says nothing changed", () => {
      expect(sentence({ ok: false, reason, code: "quota_frozen" })).toBe(
        "This write was refused: quota_frozen. Nothing was changed.",
      );
    });
  });

  it("names the role problem, not the missing mandate, for org_role_required", () => {
    expect(
      sentence({ ok: false, reason: "denied", code: "org_role_required" }),
    ).toMatch(/^Your roles on this organization are not accountable/);
  });

  it("answers a refused form with one sentence whatever the code or field", () => {
    const text = expected("invalid");
    expect(sentence({ ok: false, reason: "invalid", code: "x" })).toBe(text);
    expect(
      sentence({
        ok: false,
        reason: "invalid",
        code: "validity_inverted",
        field: "validUntil",
      }),
    ).toBe(text);
  });

  it("names the access request a parked write waits on", () => {
    expect(
      sentence({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "ar_42",
      }),
    ).toBe("This write is waiting for approval. Access request ar_42.");
  });

  it.each(["gau_exhausted", "billing_suspended", "budget_exceeded"] as const)(
    "reports an exhausted %s as unanswered with its code",
    (code) => {
      expect(sentence({ ok: false, reason: "exhausted", code })).toBe(
        `This write could not be answered: ${code}. Nothing was changed.`,
      );
    },
  );

  it("asks for a retry when the time zone could not be read", () => {
    expect(
      sentence({
        ok: false,
        reason: "unavailable",
        code: "time_zone_unavailable",
      }),
    ).toBe(expected("timeZoneUnavailable"));
  });

  it("does not treat time_zone_unavailable as a handler refusal", () => {
    // Under a coded refusal it is not a known reason, so it prints as recorded.
    expect(
      sentence({ ok: false, reason: "denied", code: "time_zone_unavailable" }),
    ).toBe(
      "This write was refused: time_zone_unavailable. Nothing was changed.",
    );
  });

  it("does not treat time_zone_unsupported as retryable when it arrives as unavailable", () => {
    expect(
      sentence({
        ok: false,
        reason: "unavailable",
        code: "time_zone_unsupported",
      }),
    ).toBe(
      "This write could not be answered: time_zone_unsupported. Nothing was changed.",
    );
  });

  it("reports any other unavailable code as recorded", () => {
    expect(
      sentence({ ok: false, reason: "unavailable", code: "upstream_timeout" }),
    ).toBe(
      "This write could not be answered: upstream_timeout. Nothing was changed.",
    );
  });

  it("names a write that threw before it answered as action_failed", () => {
    expect(UNANSWERED).toEqual({
      ok: false,
      reason: "unavailable",
      code: "action_failed",
    });
    expect(sentence(UNANSWERED)).toBe(
      "This write could not be answered: action_failed. Nothing was changed.",
    );
  });
});
