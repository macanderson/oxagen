/**
 * The decisions `tools/scripts/assistant-model-keys.ts` makes, as pure
 * functions over owned data (ADR-131).
 *
 * They live here rather than in the script because the script opens a database
 * connection and calls `process.exit` at import time, so nothing in it can be
 * imported by a test. Each function below answers one question the script used
 * to answer inline, and each one got it wrong in a way that was invisible from
 * the output: a mistyped cap that removed the cap, a vendor outage that
 * reported as a clean run, a deleted key reported as a live one, and a ceiling
 * that changed its reset window without changing its dollar figure.
 */

/** A cap that was read, or the reason it could not be. */
export type LimitFlag =
  | { readonly ok: true; readonly limit: number }
  | { readonly ok: false; readonly got: string | undefined };

/**
 * Read `--limit N` out of the argument list.
 *
 * Absent is the only form of "no cap", and it is written by leaving the flag
 * off. Every other unreadable form fails, because this flag bounds a run that
 * mints spendable vendor credentials: a `--limit nope` that falls back to no
 * limit turns a typo into a mint for every eligible organisation.
 */
export function parseLimitFlag(argv: readonly string[]): LimitFlag {
  const at = argv.indexOf("--limit");
  if (at === -1) return { ok: true, limit: Number.POSITIVE_INFINITY };

  const raw = argv[at + 1];
  if (raw === undefined || raw.startsWith("--") || raw.trim() === "") {
    return { ok: false, got: raw };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, got: raw };
  return { ok: true, limit: n };
}

/** What one organisation's provisioning attempt was. */
export type BackfillOutcome = "minted" | "skipped" | "failed";

/**
 * Judge one `ensureAssistantModelKey` result.
 *
 * `already` and `race` are the only normal non-mints: both mean the
 * organisation ends the run with a key. `error` is every vendor and storage
 * failure the provisioner swallows, and `disabled` means the run had no
 * management key at all, so neither one leaves a key behind and neither is a
 * skip. Counting them as skips let an OpenRouter outage mint nothing, print
 * `failed 0`, and exit 0.
 */
export function classifyBackfillOutcome(result: {
  readonly provisioned: boolean;
  readonly reason?: string;
}): BackfillOutcome {
  if (result.provisioned) return "minted";
  if (result.reason === "already" || result.reason === "race") return "skipped";
  return "failed";
}

/** The fields of a vendor key this module needs to judge it. */
export interface VendorKeyFacts {
  readonly hash: string;
  readonly disabled: boolean;
  readonly limit: number | null;
  readonly limitReset: string | null;
}

/**
 * Is this row disabled here while its key still spends at the vendor?
 *
 * The vendor key must be found AND live. Reading a missing key as a live one
 * is what reported a row that is disabled here and deleted at the vendor both
 * as a phantom and as a credential to go and disable, which cannot both be
 * true and sends the operator after something that does not exist.
 */
export function isLiveAtVendorButDisabledHere(
  row: { readonly status: string; readonly keyHash: string },
  vendorKeys: readonly VendorKeyFacts[],
): boolean {
  if (row.status === "active") return false;
  const atVendor = vendorKeys.find((k) => k.hash === row.keyHash);
  return atVendor !== undefined && !atVendor.disabled;
}

/**
 * Has this key's ceiling drifted from the row that records it?
 *
 * The reset window is half the ceiling. A key that keeps its $25 but resets
 * weekly rather than daily has had its blast radius multiplied by seven, and
 * comparing the dollar figure alone calls that synchronised. The production
 * key named "$300/day" that resets weekly is the standing example of a window
 * nobody checked.
 */
export function hasCeilingDrift(
  vendorKey: VendorKeyFacts,
  expectedDailyLimitUsd: number,
): boolean {
  if (vendorKey.limitReset !== "daily") return true;
  return vendorKey.limit !== expectedDailyLimitUsd;
}
