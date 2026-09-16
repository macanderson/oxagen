"use server";
// The three writes on the API keys page (ARCHITECTURE.md §1.2): mint a key,
// replace one, and end one. All three run through the kernel seam for the
// organization the URL names, all three are `noBillingGate` (INV-28), and all
// three are role-checked in their handler (INV-29): an Owner or an Admin
// writes, anyone else is answered `denied` with nothing changed.
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

/** A date the picker produced, as a day and nothing finer. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant the contract takes for a key that expires on the chosen day, or
 * null when the field is not a day this calendar has. `new Date` rolls a
 * February 31st forward, so the round trip is what rejects it.
 */
function expiryInstant(day: string): string | null {
  if (!DAY.test(day)) return null;
  const instant = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime())) return null;
  const iso = instant.toISOString();
  return iso.startsWith(day) ? iso : null;
}

/**
 * Mints a key for this organization and returns its secret. The name and the
 * expiry are refused here when they are not something the contract can take,
 * so a mistyped field is named in the form rather than answered by the kernel.
 */
export async function createApiKey(
  org: string,
  name: string,
  expiresOn: string,
): Promise<ActionResult<NewApiKey>> {
  const ctx = await requireViewer(org);
  const label = name.trim();
  if (label === "") {
    return {
      ok: false,
      reason: "invalid",
      code: "name_required",
      field: "name",
    };
  }
  let expiresAt: string | undefined;
  if (expiresOn !== "") {
    const instant = expiryInstant(expiresOn);
    if (instant === null) {
      return {
        ok: false,
        reason: "invalid",
        code: "expiry_not_a_day",
        field: "expiresAt",
      };
    }
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
  keyId: string,
): Promise<ActionResult<NewApiKey>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, apiKeyRotate, { keyPublicId: keyId });
  return result.ok ? { ok: true, value: shown(result.value) } : result;
}

/** Ends the key: every request presenting it is refused from this moment. */
export async function revokeApiKey(
  org: string,
  keyId: string,
): Promise<ActionResult<{ keyId: string }>> {
  const ctx = await requireViewer(org);
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
