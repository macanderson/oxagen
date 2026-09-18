"use server";
// The three writes on the Model funding page (ADR-053 §2): test a key, store
// it, and remove it. All three are organisation-scoped — the key pays for
// every workspace's assistant turns — all three are `noBillingGate`, and all
// three are role-checked in their handler (INV-29): an Owner or an Admin
// writes, anyone else is answered `denied` with nothing changed.
//
// Each takes the organization slug and resolves it through `requireViewer`,
// which is where membership is checked. Slugs only — no action reads an org id
// off its input (INV-19).
//
// The key crosses this boundary once, inward. Nothing here returns it: the
// store action answers with the same redacted view the page reads, and the
// test action answers with the vendor's verdict. A form that keeps the key in
// client state past a successful save is the only place it could leak, and
// the form clears it on success.
import { orgModelCredentialDelete } from "@oxagen/oxagen/contracts/org.model_credential.delete";
import { orgModelCredentialSet } from "@oxagen/oxagen/contracts/org.model_credential.set";
import { orgModelCredentialVerify } from "@oxagen/oxagen/contracts/org.model_credential.verify";
import type { ModelCredential, ModelProvider } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { needsBaseUrl, needsModelMap } from "./model-funding-rules";

/** What the form submits. Empty strings are "not given". */
export type ModelKeyInput = {
  readonly provider: ModelProvider;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly balanced: string;
  readonly fast: string;
  readonly precise: string;
};

/** The vendor's answer to "does this key work, and can it call tools?" */
export type ModelKeyVerdict = {
  readonly ok: boolean;
  readonly toolCalling: boolean | null;
  readonly latencyMs: number;
  readonly error: string | null;
};

/** A refusal the form names on a field, before any capability runs. */
function invalid(code: string, field: string): ActionResult<never> {
  return { ok: false, reason: "invalid", code, field };
}

/**
 * The same checks the contract makes, run first so a missing field is named
 * next to that field rather than answered by the kernel as a whole-form error.
 * The contract still makes them — this is only the earlier, kinder half.
 */
function precheck(input: ModelKeyInput): ActionResult<never> | null {
  if (input.apiKey.trim().length < 8) return invalid("key_required", "apiKey");
  if (needsBaseUrl(input.provider) && input.baseUrl.trim() === "")
    return invalid("base_url_required", "baseUrl");
  if (needsModelMap(input.provider) && input.balanced.trim() === "")
    return invalid("balanced_model_required", "balanced");
  return null;
}

/** The model map the contract takes: only the tiers given, trimmed. */
function modelMapOf(input: ModelKeyInput) {
  if (!needsModelMap(input.provider)) return undefined;
  const map: { balanced?: string; fast?: string; precise?: string } = {};
  for (const tier of ["balanced", "fast", "precise"] as const) {
    const value = input[tier].trim();
    if (value !== "") map[tier] = value;
  }
  return map;
}

/**
 * Asks the vendor whether the key works, without storing it. For an
 * OpenAI-compatible endpoint it also asks the balanced model for one forced
 * tool call, because the assistant cannot answer anything without tools.
 */
export async function testModelKey(
  org: string,
  input: ModelKeyInput,
): Promise<ActionResult<ModelKeyVerdict>> {
  const refused = precheck(input);
  if (refused) return refused;
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, orgModelCredentialVerify, {
    provider: input.provider,
    apiKey: input.apiKey.trim(),
    ...(needsBaseUrl(input.provider)
      ? {
          baseUrl: input.baseUrl.trim(),
          toolProbeModel: input.balanced.trim(),
        }
      : {}),
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      ok: result.value.ok,
      toolCalling: result.value.toolCalling,
      latencyMs: result.value.latencyMs,
      error: result.value.error,
    },
  };
}

/** Stores the key (replacing any key already stored) and returns the redacted view. */
export async function saveModelKey(
  org: string,
  input: ModelKeyInput,
): Promise<ActionResult<ModelCredential>> {
  const refused = precheck(input);
  if (refused) return refused;
  const ctx = await requireViewer(org);
  const modelMap = modelMapOf(input);
  return kernelWrite(ctx, orgModelCredentialSet, {
    provider: input.provider,
    apiKey: input.apiKey.trim(),
    ...(needsBaseUrl(input.provider) ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(modelMap === undefined ? {} : { modelMap }),
  });
}

/** Removes the key; the organisation's next turn runs on Oxagen's key. */
export async function removeModelKey(
  org: string,
): Promise<ActionResult<ModelCredential>> {
  const ctx = await requireViewer(org);
  return kernelWrite(ctx, orgModelCredentialDelete, {});
}
