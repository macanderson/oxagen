import { describe, expect, it } from "vitest";
import { userPreferencesSet } from "./user.preferences.set";
import { userPreferencesRead } from "./user.preferences.read";

describe("set_preferences contract", () => {
  it("is a user-global settings write: unscoped, mutating, noBillingGate", () => {
    expect(userPreferencesSet.scoped).toBe(false);
    expect(userPreferencesSet.mutates).toBe(true);
    expect(userPreferencesSet.noBillingGate).toBe(true);
  });

  it("is partial: an empty write is valid and every field is optional", () => {
    expect(userPreferencesSet.input.parse({})).toEqual({});
    expect(
      userPreferencesSet.input.parse({
        locale: "pt-BR",
        theme: "dark",
        timezone: "America/Sao_Paulo",
      }),
    ).toEqual({
      locale: "pt-BR",
      theme: "dark",
      timezone: "America/Sao_Paulo",
    });
  });

  it("carries the appearance, input-behaviour and model fields too", () => {
    const full = {
      locale: "en",
      theme: "light" as const,
      timezone: "UTC",
      fontSize: "large" as const,
      density: "compact" as const,
      enterToSubmit: true,
      pendingPromptBehavior: "interrupt" as const,
      defaultTextTier: "precise" as const,
      defaultTextModel: "anthropic/claude-sonnet-4",
    };
    expect(userPreferencesSet.input.parse(full)).toEqual(full);
  });

  // The three-way distinction the two nullable columns encode. Collapsing null
  // into undefined would make "clear my pinned model" unexpressible, which is
  // the only way back to workspace routing once a model is pinned.
  it("distinguishes clearing a model preference from leaving it alone", () => {
    expect(
      userPreferencesSet.input.parse({
        defaultTextTier: null,
        defaultTextModel: null,
      }),
    ).toEqual({ defaultTextTier: null, defaultTextModel: null });
    expect("defaultTextTier" in userPreferencesSet.input.parse({})).toBe(false);
  });

  it("refuses a theme outside the three, a malformed locale or zone, and an unknown key (negative)", () => {
    expect(userPreferencesSet.input.safeParse({ theme: "sepia" }).success).toBe(
      false,
    );
    expect(
      userPreferencesSet.input.safeParse({ locale: "English" }).success,
    ).toBe(false);
    expect(
      userPreferencesSet.input.safeParse({ timezone: "GMT +1" }).success,
    ).toBe(false);
    expect(
      userPreferencesSet.input.safeParse({ fontSize: "enormous" }).success,
    ).toBe(false);
    expect(
      userPreferencesSet.input.safeParse({ pendingPromptBehavior: "drop" })
        .success,
    ).toBe(false);
    expect(
      userPreferencesSet.input.safeParse({ defaultTextModel: "" }).success,
    ).toBe(false);
    expect(
      userPreferencesSet.input.safeParse({ notAPreference: true }).success,
    ).toBe(false);
  });

  it("answers with the whole account set", () => {
    const output = {
      locale: "en",
      theme: "system" as const,
      timezone: "UTC",
      fontSize: "medium" as const,
      density: "comfortable" as const,
      enterToSubmit: false,
      pendingPromptBehavior: "queue" as const,
      defaultTextTier: null,
      defaultTextModel: null,
    };
    expect(userPreferencesSet.output.parse(output)).toEqual(output);
    expect(
      userPreferencesSet.output.safeParse({ locale: "en", theme: "system" })
        .success,
    ).toBe(false);
  });

  // ADR-075: one writer for the row, carrying every field the read returns. A
  // field readable and unsettable is a dead value — `defaultTextTier` and
  // `defaultTextModel` are read back by `loadEffectiveModelDefaults` on every
  // turn, so a write contract missing them pins the default at null forever.
  // `language` on the read is `locale` on the write, which is the one rename.
  it("can set every field get_user_preferences returns (ADR-075)", () => {
    const readable = new Set(
      Object.keys(userPreferencesRead.output.shape).map((k) =>
        k === "language" ? "locale" : k,
      ),
    );
    const writable = new Set(Object.keys(userPreferencesSet.input.shape));
    const unsettable = [...readable].filter((k) => !writable.has(k));
    expect(
      unsettable,
      `readable but unsettable: ${unsettable.join(", ")}`,
    ).toEqual([]);
  });
});
