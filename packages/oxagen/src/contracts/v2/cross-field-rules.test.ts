import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { billingBudgetSet } from "../billing.budget.set";
import { billingUsageBreakdown } from "../billing.usage.breakdown";
import { contextRecordPublish } from "../context.record.publish";
import { changeSubscription } from "./change-subscription";
import { eraseData } from "./erase-data";
import { getSpend } from "./get-spend";
import { openContextPr } from "./open-context-pr";
import { setBudget } from "./set-budget";
import { setConnection } from "./set-connection";

/**
 * The cross-field rules on v2 inputs.
 *
 * `manifest.test.ts` and `exhaustive.test.ts` prove the carry is complete at
 * the field level — every key is present or declared dropped. Neither can see a
 * `.refine`: a ZodEffects has no shape, so a rule that was carried with the
 * wrong predicate, or with a reworded message, passes both. These tests parse
 * real inputs through each refined v2 schema, and where a rule was carried from
 * a v1 contract they compare the v2 message against the v1 contract's own
 * output for the same input, so "reproduced verbatim" is checked rather than
 * restated.
 */

/** Messages for the issues a failed parse reports at `path`. */
function messagesAt(
  schema: z.ZodTypeAny,
  input: unknown,
  path: string,
): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues
    .filter((i) => i.path.join(".") === path)
    .map((i) => i.message);
}

describe("change_subscription input", () => {
  const checkout = {
    successUrl: "https://app.example.com/billing?ok=1",
    cancelUrl: "https://app.example.com/billing",
  };

  it("accepts a plan change with interval and both return URLs", () => {
    expect(
      changeSubscription.input.safeParse({
        planSlug: "team",
        interval: "year",
        ...checkout,
      }).success,
    ).toBe(true);
  });

  it("accepts a cancellation that names no plan and opens no Checkout", () => {
    expect(
      changeSubscription.input.safeParse({ cancelAtPeriodEnd: true }).success,
    ).toBe(true);
    // false clears a scheduled cancellation, and is still an intent.
    expect(
      changeSubscription.input.safeParse({ cancelAtPeriodEnd: false }).success,
    ).toBe(true);
  });

  it("rejects a call that states neither intent", () => {
    expect(messagesAt(changeSubscription.input, {}, "planSlug")).toEqual([
      "provide planSlug (with interval) to change plan, or cancelAtPeriodEnd to schedule or clear a cancellation",
    ]);
  });

  it("requires interval alongside planSlug", () => {
    expect(
      messagesAt(
        changeSubscription.input,
        { planSlug: "team", ...checkout },
        "interval",
      ),
    ).toEqual(["interval is required when planSlug is given"]);
  });

  it("requires both return URLs for a plan change", () => {
    const message = "successUrl and cancelUrl are required for a plan change";
    expect(
      messagesAt(
        changeSubscription.input,
        { planSlug: "team", interval: "month" },
        "successUrl",
      ),
    ).toEqual([message]);
    expect(
      messagesAt(
        changeSubscription.input,
        {
          planSlug: "team",
          interval: "month",
          successUrl: checkout.successUrl,
        },
        "successUrl",
      ),
    ).toEqual([message]);
  });
});

describe("erase_data input", () => {
  const orgId = "3f1c9a52-7d4e-4b8a-9c21-5e6f7a8b9c0d";

  it("accepts a user-scope erasure without an orgId", () => {
    expect(
      eraseData.input.safeParse({ scope: "user", confirm: true }).success,
    ).toBe(true);
  });

  it("accepts an org-scope erasure that names the org", () => {
    expect(
      eraseData.input.safeParse({ scope: "org", orgId, confirm: true }).success,
    ).toBe(true);
  });

  it("refuses an org-scope erasure that does not name the org", () => {
    expect(
      messagesAt(eraseData.input, { scope: "org", confirm: true }, "orgId"),
    ).toEqual(["orgId is required for scope 'org'"]);
  });

  it("still requires the literal confirmation", () => {
    expect(
      eraseData.input.safeParse({ scope: "user", confirm: false }).success,
    ).toBe(false);
  });
});

describe("set_connection input", () => {
  const base = {
    name: "openrouter production",
    kind: "model_provider" as const,
    provider: "openrouter",
  };

  it("accepts a create that carries the candidate secret", () => {
    expect(
      setConnection.input.safeParse({ ...base, secret: "sk-or-v1-abcdefgh" })
        .success,
    ).toBe(true);
  });

  it("accepts an oauth create that carries tokens instead of a secret", () => {
    expect(
      setConnection.input.safeParse({
        ...base,
        kind: "oauth",
        provider: "github",
        accessToken: "gho_abcdefgh",
      }).success,
    ).toBe(true);
  });

  it("accepts a re-test that names the stored connection and no secret", () => {
    expect(
      setConnection.input.safeParse({ ...base, connectionId: "conn_123" })
        .success,
    ).toBe(true);
  });

  it("refuses a call carrying neither secret material nor a connectionId", () => {
    expect(messagesAt(setConnection.input, base, "secret")).toEqual([
      "secret and connectionId must not both be omitted — supply secret material to test a candidate credential, or connectionId alone to test the stored one",
    ]);
  });

  /**
   * The half of `verify_model_credential`'s rule that this tool did not have to
   * refine: verify made `provider` optional and had to reject a key without
   * one, and here `provider` is required, so the object rejects it before any
   * refinement runs. Asserted so a later loosening of `provider` cannot silently
   * reopen the case the source contract was written to close.
   */
  it("still cannot be given secret material with no provider", () => {
    const { provider: _dropped, ...noProvider } = base;
    expect(
      setConnection.input.safeParse({ ...noProvider, secret: "sk-or-v1-abcd" })
        .success,
    ).toBe(false);
  });

  /**
   * The rename is what makes the carry legible, so it is checked rather than
   * assumed: `verify_model_credential`'s `apiKey` is this tool's `secret`, and
   * the 8–512 bound travels with the imported schema.
   */
  it("keeps the absorbed key schema's lower bound under the new name", () => {
    expect(
      setConnection.input.safeParse({ ...base, secret: "short" }).success,
    ).toBe(false);
  });
});

describe("get_spend input", () => {
  const start = "2026-08-01T00:00:00Z";

  it("accepts an org rollup with no scopeId", () => {
    const parsed = getSpend.input.safeParse({
      start,
      end: "2026-09-01T00:00:00Z",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.level).toBe("org");
  });

  it("accepts a workspace rollup with no scopeId", () => {
    expect(
      getSpend.input.safeParse({
        start,
        end: "2026-09-01T00:00:00Z",
        level: "workspace",
      }).success,
    ).toBe(true);
  });

  it("carries the window rules verbatim from get_usage_breakdown", () => {
    const backwards = { start, end: "2026-07-01T00:00:00Z" };
    const tooLong = { start, end: "2027-08-03T00:00:00Z" };

    for (const input of [backwards, tooLong]) {
      const v1 = messagesAt(billingUsageBreakdown.input, input, "end");
      // Guard against a vacuous match: both sides must actually reject.
      expect(v1.length).toBeGreaterThan(0);
      expect(messagesAt(getSpend.input, input, "end")).toEqual(v1);
    }

    expect(messagesAt(getSpend.input, backwards, "end")).toContain(
      "end must be after start",
    );
    expect(messagesAt(getSpend.input, tooLong, "end")).toContain(
      "range must not exceed 366 days",
    );
  });

  it("requires scopeId for every level below workspace", () => {
    const end = "2026-09-01T00:00:00Z";
    for (const level of ["operator", "agent", "run", "turn"] as const) {
      expect(
        messagesAt(getSpend.input, { start, end, level }, "scopeId"),
      ).toEqual([
        "scopeId is required for level 'operator', 'agent', 'run' and 'turn'",
      ]);
      expect(
        getSpend.input.safeParse({ start, end, level, scopeId: "agt_1" })
          .success,
      ).toBe(true);
    }
  });
});

describe("set_budget input", () => {
  // The ceiling is Money since ADR-057 decision 2: micro-units in a decimal
  // string with their currency, never a float.
  const base = {
    enabled: true,
    limit: { micros: "250000000", currency: "USD" },
  };

  it("accepts an org monthly ceiling and defaults mode to hard", () => {
    const parsed = setBudget.input.safeParse({
      ...base,
      scope: "org",
      period: "monthly",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mode).toBe("hard");
  });

  it("carries the windowDays rule verbatim from set_spend_budget", () => {
    const rollingWithoutWindow = { ...base, scope: "org", period: "rolling" };
    const monthlyWithWindow = {
      ...base,
      scope: "org",
      period: "monthly",
      windowDays: 30,
    };

    for (const input of [rollingWithoutWindow, monthlyWithWindow]) {
      const v1 = messagesAt(billingBudgetSet.input, input, "windowDays");
      expect(v1.length).toBeGreaterThan(0);
      expect(messagesAt(setBudget.input, input, "windowDays")).toEqual(v1);
    }

    expect(
      setBudget.input.safeParse({ ...rollingWithoutWindow, windowDays: 7 })
        .success,
    ).toBe(true);
  });

  it("applies the windowDays rule to the new daily and turn periods", () => {
    expect(
      messagesAt(
        setBudget.input,
        { ...base, scope: "org", period: "turn", windowDays: 1 },
        "windowDays",
      ),
    ).toHaveLength(1);
    expect(
      setBudget.input.safeParse({ ...base, scope: "org", period: "daily" })
        .success,
    ).toBe(true);
  });

  it("requires a non-empty scopeId for operator and agent budgets", () => {
    const message = "scopeId is required for scope 'operator' and 'agent'";
    for (const scope of ["operator", "agent"] as const) {
      const input = { ...base, scope, period: "monthly" };
      expect(messagesAt(setBudget.input, input, "scopeId")).toEqual([message]);
      expect(
        messagesAt(setBudget.input, { ...input, scopeId: "" }, "scopeId"),
      ).toEqual([message]);
      expect(
        setBudget.input.safeParse({ ...input, scopeId: "op_1" }).success,
      ).toBe(true);
    }
  });

  it("does not require scopeId at workspace scope", () => {
    expect(
      setBudget.input.safeParse({
        ...base,
        scope: "workspace",
        period: "monthly",
      }).success,
    ).toBe(true);
  });
});

describe("open_context_pr input", () => {
  const base = {
    lineageId: "ctx.review.no-force-push",
    title: "Never force-push a shared branch",
    body: 'statement = "Never force-push a shared branch"\n',
    statement: "Never force-push a shared branch",
    sharingScope: "workspace",
    rationale: "Rewriting shared history invalidates every open checkout.",
  };
  /** The same call as a v1 publish, which keys on `record_id` (#3302 drops it). */
  const asV1 = (input: Record<string, unknown>) => {
    const { lineageId, sharingScope, rationale, supportingRecordIds, ...rest } =
      input;
    return { ...rest, record_id: lineageId };
  };

  it("accepts a constraint that declares its effect", () => {
    expect(
      openContextPr.input.safeParse({
        ...base,
        kind: "constraint",
        force: "must",
        constraintEffect: "forbid",
      }).success,
    ).toBe(true);
  });

  it("carries the constraint-effect rule verbatim from publish_context_record", () => {
    const constraintWithoutEffect = {
      ...base,
      kind: "constraint",
      force: "must",
    };
    const patternWithEffect = {
      ...base,
      kind: "rule",
      force: "should",
      constraintEffect: "require",
    };

    for (const input of [constraintWithoutEffect, patternWithEffect]) {
      const v1 = messagesAt(
        contextRecordPublish.input,
        asV1(input),
        "constraintEffect",
      );
      expect(v1.length).toBeGreaterThan(0);
      expect(
        messagesAt(openContextPr.input, input, "constraintEffect"),
      ).toEqual(v1);
    }
  });

  it("requires the classification a record needs to steer at all", () => {
    // Without kind and force, `readWorkspaceSteering` never delivers the merged
    // record — so the PR cannot open without them.
    for (const field of ["kind", "force", "statement"] as const) {
      const { [field]: _omitted, ...without } = {
        ...base,
        kind: "rule",
        force: "should",
      };
      expect(
        messagesAt(openContextPr.input, without, field).length,
      ).toBeGreaterThan(0);
    }
  });
});
