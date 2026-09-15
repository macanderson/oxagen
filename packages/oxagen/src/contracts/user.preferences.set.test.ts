import { describe, expect, it } from "vitest";
import { userPreferencesSet } from "./user.preferences.set";

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
      userPreferencesSet.input.safeParse({ fontSize: "large" }).success,
    ).toBe(false);
  });

  it("answers with the whole account set", () => {
    const output = { locale: "en", theme: "system", timezone: "UTC" };
    expect(userPreferencesSet.output.parse(output)).toEqual(output);
    expect(
      userPreferencesSet.output.safeParse({ locale: "en", theme: "system" })
        .success,
    ).toBe(false);
  });
});
