/**
 * `set_preferences`: the Account dialog's Preferences tab (MC spec App. E;
 * Mockups `origin/main` `mc.html` 11969-12049). A partial write: only the
 * fields the caller sends change, and the answer is the whole
 * account-preference set after the write, which is also what
 * `get_user_preferences` reads.
 *
 * It is the ONE writer of `auth.user_preferences` (ADR-075). Every field
 * `get_user_preferences` returns is settable here, because a preference the
 * product reads and no surface can set is a dead value: `defaultTextTier` and
 * `defaultTextModel` are read back by `prepareAssistantTurn` through
 * `loadEffectiveModelDefaults`, so a write contract missing them pins every
 * user's model default at null forever. `locale` is the input name for the
 * row's `language` column, which is what the read answers with.
 *
 * User-global, so `scoped: false`: preferences follow the person across
 * organisations, and the kernel enters no tenant scope for the call.
 *
 * A settings write is never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

const preferenceThemeSchema = z.enum(["system", "light", "dark"]);

/** A BCP 47 tag the interface has a catalog for; the app decides the set. */
const localeSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a BCP 47 language tag");

/** An IANA zone name (`Area/City`, `UTC`, `Etc/GMT+1`). */
const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/, "an IANA time zone name");

/** Interface appearance, carried from the `auth.user_preferences` columns. */
const fontSizeSchema = z.enum(["small", "medium", "large"]);
const densitySchema = z.enum(["compact", "comfortable", "spacious"]);

/** What to do with a prompt typed while a reply is still streaming. */
const pendingPromptBehaviorSchema = z.enum(["queue", "interrupt"]);

/** The routing tier a turn starts from when the user has pinned one. */
const modelTierSchema = z.enum(["fast", "balanced", "precise"]);

export const userPreferencesSet = registerCapability({
  name: "set_preferences",
  domain: "user",
  description:
    "Set the calling user's account preferences — locale, theme, timezone, appearance, input behaviour and default text model — as a partial write, and return the whole set after it.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  // `app`: the Account dialog's Preferences tab writes through it
  // (apps/app/src/features/shell/account-actions.ts).
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  mutates: true,
  noBillingGate: true,
  sensitivity: "low",
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
  input: z
    .object({
      locale: localeSchema.optional(),
      theme: preferenceThemeSchema.optional(),
      timezone: timezoneSchema.optional(),
      fontSize: fontSizeSchema.optional(),
      density: densitySchema.optional(),
      enterToSubmit: z.boolean().optional(),
      pendingPromptBehavior: pendingPromptBehaviorSchema.optional(),
      // Nullable-optional, the three-way distinction the column encodes:
      // omitted means no change, `null` clears the preference and falls back to
      // workspace routing, a value pins it.
      defaultTextTier: modelTierSchema.nullable().optional(),
      defaultTextModel: z.string().min(1).nullable().optional(),
    })
    .strict(),
  output: z
    .object({
      locale: z.string(),
      theme: preferenceThemeSchema,
      timezone: z.string(),
      fontSize: fontSizeSchema,
      density: densitySchema,
      enterToSubmit: z.boolean(),
      pendingPromptBehavior: pendingPromptBehaviorSchema,
      defaultTextTier: modelTierSchema.nullable(),
      defaultTextModel: z.string().nullable(),
    })
    .strict(),
});

export type UserPreferencesSetInput = z.output<typeof userPreferencesSet.input>;
export type UserPreferencesSetOutput = z.output<
  typeof userPreferencesSet.output
>;
