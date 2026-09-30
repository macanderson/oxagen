/**
 * The OpenAI-compatible endpoint of each direct vendor whose URL Oxagen spells
 * (ADR-053 §2). The provider client (`models.ts`) sends a direct credential's
 * completions here, and the credential probe (`credential-probe.ts`) sends its
 * tool-calling question to the same place, so the probe asks the endpoint the
 * turn will use (#3314). `openai_compatible` is absent: its URL is the
 * customer's.
 *
 * A module of its own so the probe does not import `models.ts`, which pulls
 * in the gateway client and the environment.
 */
export const DIRECT_PROVIDER_BASE_URL = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
} as const;
