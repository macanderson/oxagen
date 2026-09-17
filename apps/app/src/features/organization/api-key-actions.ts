"use server";
// The three writes on the API keys page (ARCHITECTURE.md §1.2): mint a key,
// replace one, and end one. All three run in the workspace the page named, all
// three are `noBillingGate` (INV-28), and all three are role-checked in their
// handler (INV-29): an Owner or an Admin writes, anyone else is answered
// `denied` with nothing changed.
//
// Each takes an organization slug and a workspace slug and resolves both
// through `requireViewer`, which is where membership is checked. A key names a
// workspace (ADR-073): `auth.api_keys` is policy class `standard`, so a write
// under the org-only sentinel mints a credential bound to a workspace that
// does not exist and the secret it shows authenticates into nothing. Slugs
// only — no action reads an org or workspace id off its input (INV-19).
//
// The expiry a person picks is the end of that day in UTC. `<input type="date">`
// carries no timezone, so the field is labelled UTC and the dialog shows the
// instant it encodes rather than leaving the reader to guess (ADR-073's page is
// the one that mints; `shared/expiry-day.ts` has the reasoning).
//
// `create_api_key` and `rotate_api_key` return the raw key once and store only
// its prefix and a SHA-256 hash, so the secret exists nowhere but the value
// these two actions return. No read carries it: `list_api_keys` has no field
// for a secret or a hash and neither does the `ApiKey` view model, so the page
// can show a secret only for as long as it holds this result in client state.
import { apiKeyCreate } from "@oxagen/oxagen/contracts/api.key.create";
import { apiKeyRevoke } from "@oxagen/oxagen/contracts/api.key.revoke";
import { apiKeyRotate } from "@oxagen/oxagen/contracts/api.key.rotate";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { endOfUtcDay } from "@/shared/expiry-day";

/**
 * A key as it exists for the one moment it is shown: what the roster will call
 * it, the prefix that identifies it afterwards, and the secret itself. The
 * secret is in this type and in no view model.
 */
export type NewApiKey = {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly secret: string;
  readonly expiresAt: string | null;
};

/** A refusal the form names on a field, before any capability runs. */
function invalid(code: string, field: string): ActionResult<never> {
  return { ok: false, reason: "invalid", code, field };
}

/**
 * Mints a key in the named workspace and returns its secret. The name and the
 * expiry are refused here when they are not something the contract can take,
 * so a mistyped field is named in the form rather than answered by the kernel.
 */
export async function createApiKey(
  org: string,
  ws: string,
  name: string,
  expiresOn: string,
): Promise<ActionResult<NewApiKey>> {
  const ctx = await requireViewer(org, ws);
  const label = name.trim();
  if (label === "") return invalid("name_required", "name");
  let expiresAt: string | undefined;
  if (expiresOn !== "") {
    // The chosen day is a UTC day, which is what the field says it is
    // (`shared/expiry-day.ts`), and the dialog prints the instant beneath the
    // control so the label and the stored value are the same thing on screen.
    const instant = endOfUtcDay(expiresOn);
    if (instant === null) return invalid("expiry_not_a_day", "expiresAt");
    // A day already over mints a key that is expired on arrival. Refused here,
    // with the secret unspent, rather than shown once and never usable.
    if (Date.parse(instant) <= Date.now())
      return invalid("expiry_in_the_past", "expiresAt");
    expiresAt = instant;
  }
  const result = await kernelWrite(ctx, apiKeyCreate, {
    name: label,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  return result.ok ? { ok: true, value: shown(result.value) } : result;
}

/**
 * Issues a replacement for the key and revokes the one it replaces, in one
 * transaction. The replacement carries the old key's expiry and its own secret,
 * shown once like any other.
 */
export async function rotateApiKey(
  org: string,
  ws: string,
  keyId: string,
): Promise<ActionResult<NewApiKey>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, apiKeyRotate, { keyPublicId: keyId });
  return result.ok ? { ok: true, value: shown(result.value) } : result;
}

/** Ends the key: every request presenting it is refused from this moment. */
export async function revokeApiKey(
  org: string,
  ws: string,
  keyId: string,
): Promise<ActionResult<{ keyId: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, apiKeyRevoke, { keyPublicId: keyId });
  return result.ok
    ? { ok: true, value: { keyId: result.value.keyPublicId } }
    : result;
}

/** The two minting contracts answer with the same shape; the page shows one. */
function shown(minted: {
  publicId: string;
  name: string;
  keyPrefix: string;
  rawKey: string;
  expiresAt: string | null;
}): NewApiKey {
  return {
    id: minted.publicId,
    name: minted.name,
    prefix: minted.keyPrefix,
    secret: minted.rawKey,
    expiresAt: minted.expiresAt,
  };
}
