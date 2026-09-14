// Probe for fixture-tokens.test.ts: a dev-only data switch, the form INV-22 bans.
export const fixtureMode = process.env.MC_DATA === "fixture";
