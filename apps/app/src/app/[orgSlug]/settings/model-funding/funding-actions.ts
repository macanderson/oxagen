"use server";
/**
 * funding-actions.ts — server actions for Organization → Settings → Model
 * funding (ADR-053 §2–3).
 *
 * Four actions: store the org's own model-vendor key, test a key against the
 * vendor, remove the stored key, and set the monthly cap on assistant usage
 * Oxagen pays for. The first three go through the `*_model_credential`
 * capabilities via `invoke()`, so IAM, audit and the security event all fire
 * exactly as they would from the API; the cap is a billing setting and calls
 * `@oxagen/billing` directly, like the auto-reload settings do.
 *
 * Every action re-reads the caller's org role from the database before doing
 * anything — the client's `canEdit` flag is a hint for rendering, never an
 * authority. The key is never returned, never logged, and never part of an
 * error message: a thrown error is mapped to a short fixed sentence.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler into the shared kernel so
// invoke("set_model_credential", …) can resolve its handler. Without this,
// invoke() throws "No handler registered" at runtime (the type system can't
// catch a missing side-effect import). Mirrors models-action.ts.
import "@oxagen/handlers/register";
import { updateAssistantSpendCap } from "@oxagen/billing";
import {
  modelCredentialVerificationSchema,
  modelCredentialViewSchema,
  type ModelCredentialVerification,
  type ModelCredentialView,
} from "@oxagen/oxagen/contracts/org.model_credential.shared";
import { org as orgRoutes } from "@/lib/routes";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { isAuthDenialError, isNextRedirectError } from "@/lib/auth-denial";
import {
  ORG_ONLY_WS,
  FUNDING_MANAGER_ROLES,
  buildOrgCapabilityContext,
} from "./funding-context";

// ── Validation ───────────────────────────────────────────────────────────────
//
// The bounds mirror `modelCredentialApiKeySchema` (8–512 characters); the
// messages are written for the person typing, not for a log.

const providerSchema = z.enum(["openrouter", "gateway"], {
  errorMap: () => ({ message: "Choose OpenRouter or Vercel AI Gateway." }),
});

const apiKeySchema = z
  .string()
  .trim()
  .min(8, "Enter the full API key.")
  .max(512, "That key is too long to be a vendor API key.");

const SetCredentialSchema = z.object({
  provider: providerSchema,
  apiKey: apiKeySchema,
});

const VerifyCredentialSchema = z
  .object({
    provider: providerSchema.optional(),
    apiKey: apiKeySchema.optional(),
  })
  .refine((v) => (v.provider === undefined) === (v.apiKey === undefined), {
    message: "Enter a key to test it.",
    path: ["apiKey"],
  });

const SpendCapSchema = z
  .number({ invalid_type_error: "Enter a whole number of cents, or no cap." })
  .int("The cap must be a whole number of cents.")
  .min(0, "The cap cannot be negative.")
  .nullable();

// ── Result types ─────────────────────────────────────────────────────────────

export type CredentialActionResult =
  | { ok: true; view: ModelCredentialView }
  | { ok: false; error: string };

export type VerifyActionResult =
  | { ok: true; verification: ModelCredentialVerification }
  | { ok: false; error: string };

export type SpendCapActionResult =
  | { ok: true; capCents: number | null }
  | { ok: false; error: string };

// ── Shared guard ─────────────────────────────────────────────────────────────

const FORBIDDEN =
  "Only organization owners and admins can change who pays for the assistant.";

type Denied = { ok: false; error: string };

/**
 * Authenticate, resolve the org, assert membership, enter the org-only tenant
 * scope, and re-read the caller's role. Runs `body` only for an owner/admin.
 */
async function withFundingManager<T>(
  orgSlug: string,
  body: (args: { orgId: string; userId: string }) => Promise<T>,
): Promise<T | Denied> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    async () => {
      const roleRows = await withTenantDb((tx) =>
        tx
          .select({ role: schema.orgUsers.role })
          .from(schema.orgUsers)
          .where(
            and(
              eq(schema.orgUsers.orgId, org.id),
              eq(schema.orgUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      );
      const role = (roleRows[0]?.role ?? "").toLowerCase();
      if (!FUNDING_MANAGER_ROLES.has(role)) {
        return { ok: false, error: FORBIDDEN } satisfies Denied;
      }
      return body({ orgId: org.id, userId: session.user.id });
    },
  );
}

/**
 * Turn a thrown error into the result shape. The redirect and not-found
 * sentinels must escape so Next can act on them (see general-action.ts);
 * anything else becomes the fixed sentence the caller supplied, because a
 * raw message from the kernel or the vendor client is not written for the
 * settings page and could name things the page must not show.
 */
function failed(err: unknown, sentence: string): Denied {
  if (isNextRedirectError(err) || isAuthDenialError(err)) throw err;
  return { ok: false, error: sentence };
}

function revalidate(orgSlug: string): void {
  revalidatePath(orgRoutes.settings.modelFunding({ orgSlug }));
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** Store (or replace) the organisation's own model-vendor key. */
export async function setModelCredentialAction(
  orgSlug: string,
  input: { provider: string; apiKey: string },
): Promise<CredentialActionResult> {
  const parsed = SetCredentialSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  try {
    return await withFundingManager(orgSlug, async ({ orgId, userId }) => {
      const raw = await invoke(
        "set_model_credential",
        parsed.data,
        buildOrgCapabilityContext({ orgId, userId }),
        { surface: "api" },
      );
      const view = modelCredentialViewSchema.parse(raw);
      revalidate(orgSlug);
      return { ok: true as const, view };
    });
  } catch (err) {
    return failed(err, "Saving the key failed. Test it first, then try again.");
  }
}

/**
 * Ask the vendor whether a key is accepted. With a candidate key it tests
 * that key; with no input it tests the stored one. Spends no tokens.
 */
export async function verifyModelCredentialAction(
  orgSlug: string,
  input: { provider?: string; apiKey?: string } = {},
): Promise<VerifyActionResult> {
  const parsed = VerifyCredentialSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  try {
    return await withFundingManager(orgSlug, async ({ orgId, userId }) => {
      const raw = await invoke(
        "verify_model_credential",
        parsed.data,
        buildOrgCapabilityContext({ orgId, userId }),
        { surface: "api" },
      );
      const verification = modelCredentialVerificationSchema.parse(raw);
      return { ok: true as const, verification };
    });
  } catch (err) {
    return failed(err, "Testing the key failed. Try again in a moment.");
  }
}

/** Remove the stored key and return the organisation to Oxagen's key. */
export async function deleteModelCredentialAction(
  orgSlug: string,
): Promise<CredentialActionResult> {
  try {
    return await withFundingManager(orgSlug, async ({ orgId, userId }) => {
      const raw = await invoke(
        "delete_model_credential",
        {},
        buildOrgCapabilityContext({ orgId, userId }),
        { surface: "api" },
      );
      const view = modelCredentialViewSchema.parse(raw);
      revalidate(orgSlug);
      return { ok: true as const, view };
    });
  } catch (err) {
    return failed(err, "Removing the key failed. Try again in a moment.");
  }
}

/**
 * Set the monthly cap on assistant usage Oxagen pays for, in credit cents.
 * `null` removes the cap.
 */
export async function updateAssistantSpendCapAction(
  orgSlug: string,
  capCents: number | null,
): Promise<SpendCapActionResult> {
  const parsed = SpendCapSchema.safeParse(capCents);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid cap",
    };
  }
  try {
    return await withFundingManager(orgSlug, async ({ orgId }) => {
      const settings = await updateAssistantSpendCap(orgId, parsed.data);
      revalidate(orgSlug);
      return { ok: true as const, capCents: settings.assistantSpendCapCents };
    });
  } catch (err) {
    return failed(err, "Saving the cap failed. Try again in a moment.");
  }
}
