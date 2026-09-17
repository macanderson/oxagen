// Probe for fixture-tokens.test.ts: a data-source switch, the form INV-22 bans.
export const fixtureSelected = (flags: Record<string, string>): boolean =>
  flags.MC_DATA === "fixture";
