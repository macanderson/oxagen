// @vitest-environment jsdom
// The sentence a refused mandate write shows: every reason the two bound
// handlers throw has its own sentence, under each of the three refusal kinds
// the kernel can file it as, and any other code is printed as recorded.
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { IntlProvider, translator } from "@/test/intl";
import {
  type ActionFailure,
  UNANSWERED,
  useActionFailure,
} from "./action-failure";

const t = translator("mandate.actions.failure");

function word() {
  return renderHook(useActionFailure, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <IntlProvider>{children}</IntlProvider>
    ),
  }).result.current;
}

const HANDLER_REASONS: readonly (readonly [string, string])[] = [
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
];

describe("mandate action refusal", () => {
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

  it("prints a code it has no sentence for as recorded and says nothing changed (negative)", () => {
    expect(
      word()({ ok: false, reason: "conflict", code: "something_new" }),
    ).toBe("This write was refused: something_new. Nothing was changed.");
  });

  it("names an invalid form without printing the field's code (negative)", () => {
    const sentence = word()({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "validUntil",
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
    ).toBe("This write is waiting for approval. Access request acr_7k2m.");
  });

  it("prints an exhausted budget's code as an unanswered write (negative)", () => {
    expect(
      word()({ ok: false, reason: "exhausted", code: "budget_exceeded" }),
    ).toBe(
      "This write could not be answered: budget_exceeded. Nothing was changed.",
    );
  });

  it("asks for a retry when the time zone could not be read, and prints any other outage's code (negative)", () => {
    const say = word();
    const failure: ActionFailure = {
      ok: false,
      reason: "unavailable",
      code: "time_zone_unavailable",
    };
    expect(say(failure)).toBe(t("timeZoneUnavailable"));
    expect(say(failure)).toContain("Try again.");
    expect(say(UNANSWERED)).toBe(
      "This write could not be answered: action_failed. Nothing was changed.",
    );
  });
});
