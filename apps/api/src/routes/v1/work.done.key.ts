// GET /v1/work/done/key serves the public key that signs done-record
// attestations (agent-work-spec.html, Done record). The "Oxagen done" check
// carries a DSSE envelope, and anyone can check its signature with this
// document and no Oxagen account.
//
// The deployment's attester key signs done records (ADR-195), the key a sealed
// run's attestation already uses. The spec names a workspace key, and no
// workspace key store exists yet, so every workspace shares this one. When no
// key is set, the route answers 503, so a verifier can tell a missing key from
// a wrong one.
import { Hono } from "hono";
import {
  doneAttestationKeyFromPem,
  publishedDoneKey,
  type DoneAttestationKey,
} from "@oxagen/done-record/attestation";
import { ATTESTER_KEY_ENV } from "@oxagen/run-ledger/attester-key";
import type { AppEnv } from "../../app";
import { logger } from "../../middleware/logger";

let cached: { raw: string; key: DoneAttestationKey | null } | undefined;

function parseKey(raw: string): DoneAttestationKey | null {
  try {
    // A variable store that keeps one line holds the PEM's newlines as `\n`.
    return doneAttestationKeyFromPem(raw.replace(/\\n/g, "\n"));
  } catch (err) {
    // Node's parse errors name the failure, never the key bytes.
    logger.warn(
      { env: ATTESTER_KEY_ENV, reason: String(err) },
      "the attester key is not an Ed25519 private key, so the done key and badge routes refuse",
    );
    return null;
  }
}

/**
 * The done attestation key from the deployment's attester key variable, or
 * null when the variable is unset or holds no Ed25519 PKCS#8 key. The parse is
 * cached by the variable's value, so a bad key logs once.
 */
export function doneAttestationKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DoneAttestationKey | null {
  const raw = env[ATTESTER_KEY_ENV];
  if (!raw) return null;
  if (cached?.raw !== raw) cached = { raw, key: parseKey(raw) };
  return cached.key;
}

/** What the key route reads. Tests pass their own key. */
export interface WorkDoneKeyDeps {
  signingKey: () => DoneAttestationKey | null;
}

const defaultDeps: WorkDoneKeyDeps = {
  signingKey: () => doneAttestationKeyFromEnv(),
};

export function createWorkDoneKeyRoute(deps: WorkDoneKeyDeps = defaultDeps): Hono<AppEnv> {
  const route = new Hono<AppEnv>();
  route.get("/", (c) => {
    const key = deps.signingKey();
    if (!key) {
      return c.json({ error: "not_configured" }, 503, { "Cache-Control": "no-store" });
    }
    // A rotated key shows up within five minutes.
    return c.json(publishedDoneKey(key.publicKeyPem), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });
  return route;
}

export const workDoneKeyRoute = createWorkDoneKeyRoute();
