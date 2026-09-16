/**
 * `set_preferences`: the Account dialog's Preferences tab (MC spec App. E;
 * Mockups `origin/main` `mc.html` 11969-12049): the locale the interface
 * renders in, the theme, and the timezone dates are shown in. A partial
 * write: only the fields the caller sends change, and the answer is the
 * whole account-preference set after the write, which is also what
 * `get_user_preferences` reads.
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

export const userPreferencesSet = registerCapability({
  name: "set_preferences",
  domain: "user",
  description:
    "Set the calling user's account preferences — locale, theme, timezone — as a partial write, and return the whole set after it.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: false,
  mutates: true,
  noBillingGate: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow", Viewer: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z
    .object({
      locale: localeSchema.optional(),
      theme: preferenceThemeSchema.optional(),
      timezone: timezoneSchema.optional(),
    })
    .strict(),
  output: z
    .object({
      locale: z.string(),
      theme: preferenceThemeSchema,
      timezone: z.string(),
    })
    .strict(),
});

export type UserPreferencesSetInput = z.output<typeof userPreferencesSet.input>;
export type UserPreferencesSetOutput = z.output<
  typeof userPreferencesSet.output
>;
