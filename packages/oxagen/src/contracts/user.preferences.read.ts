import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * The clock a person reads until they pick one: Pacific time, as the IANA zone
 * so the PST/PDT switch follows the rule and not a fixed offset. The column
 * default (`auth.user_preferences.timezone`, migration 20260918160000) and
 * both preference handlers carry the same value; the app falls back to it when
 * the preference read fails, so a store outage never blanks a date.
 */
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

export const userPreferencesRead = registerCapability({
  name: "get_user_preferences",
  domain: "user",
  description: "Read the calling user's UI and model preferences",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  // `app`: the organization layout reads it for every page, so each date the
  // app renders is in the person's own zone (apps/app/src/data/live/shell.ts).
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "user" },
  sensitivity: "low",
  mutates: false,
  // Self-scoped, so it is intrinsically allowed and the role map names every
  // real role — the same defect and the same reasoning as `update_profile`,
  // which cites this contract as the model it followed. The four system org
  // roles are Owner, Admin, Compliance and Billing; org-level `Member` and
  // `Viewer` do not exist (they are workspace roles), so `iam-provision` seeded
  // grants for Owner and Admin alone and an enterprise org's Compliance or
  // Billing member could not read or set their own preferences. `defaultEffect`
  // is rule 8 of the resolver and role-agnostic, so a role added later cannot
  // fall through it; an explicit deny still wins at rule 7.
  defaultEffect: "allow",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}),
  output: z.object({
    fontSize: z.enum(["small", "medium", "large"]),
    density: z.enum(["compact", "comfortable", "spacious"]),
    enterToSubmit: z.boolean(),
    pendingPromptBehavior: z.enum(["queue", "interrupt"]),
    defaultTextTier: z.enum(["fast", "balanced", "precise"]).nullable(),
    defaultTextModel: z.string().nullable(),
    /** An IANA zone name; `DEFAULT_TIME_ZONE` until the person sets one. */
    timezone: z.string(),
    language: z.string(),
    /** The Account dialog's theme choice; `system` follows the device. */
    theme: z.enum(["system", "light", "dark"]),
  }),
});

export type UserPreferencesReadInput = z.output<
  typeof userPreferencesRead.input
>;
export type UserPreferencesReadOutput = z.output<
  typeof userPreferencesRead.output
>;
