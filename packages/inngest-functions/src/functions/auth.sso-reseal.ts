// auth.sso-reseal.ts: moves every SSO provider secret onto the current key
// (ADR-145, #3740).
//
// After AUTH_TOKEN_ENCRYPTION_KEY rotates, tokens sealed under the old key
// open only while that key is listed in SSO_SECRET_PREVIOUS_KEYS. This job
// re-seals them under the current key (resealSsoProviders in
// @oxagen/database/sso-reseal), so the old key can leave the keyring.
//
// Two triggers over one body:
//   - daily at 03:30 UTC, so a rotation nobody followed up still converges;
//   - the SSO_RESEAL_REQUESTED_EVENT event, which an operator sends from the
//     Inngest dashboard right after a rotation instead of waiting a day.
//
// One row that cannot be opened is reported and logged, and the rest are
// still re-sealed. The run returns the counts so the operator can read them
// from the run output before removing the old key.

import type { StepContext } from "@oxagen/functions";
import {
  resealSsoProviders,
  type SsoResealResult,
} from "@oxagen/database/sso-reseal";
import { createFunction } from "../create-function";
import { logger } from "../logger";

/** Send this after a key rotation to re-seal every provider immediately. */
export const SSO_RESEAL_REQUESTED_EVENT = "auth/sso-secrets.reseal.requested";

async function runReseal(
  step: StepContext,
  trigger: "cron" | "event",
): Promise<SsoResealResult> {
  const result = await step.run("reseal-sso-providers", () =>
    resealSsoProviders(),
  );
  if (result.skipped) {
    logger.info({ trigger, reason: result.skipped }, "auth.sso-reseal skipped");
    return result;
  }
  if (result.failed.length > 0) {
    // Each failed provider still signs in only if its key is in the keyring.
    // Keep the retired key until this list is empty.
    logger.error(
      {
        trigger,
        failed: result.failed,
        scanned: result.scanned,
        resealed: result.resealed,
      },
      "auth.sso-reseal: providers left on a retired key",
    );
  } else {
    logger.info(
      { trigger, scanned: result.scanned, resealed: result.resealed },
      "auth.sso-reseal complete",
    );
  }
  return result;
}

export const [authSsoResealDaily] = createFunction(
  {
    id: "auth/sso-reseal-daily",
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: "30 3 * * *" },
  async ({ step }) => runReseal(step, "cron"),
);

export const [authSsoResealRequested] = createFunction(
  {
    id: "auth/sso-reseal-requested",
    retries: 3,
    concurrency: { limit: 1 },
  },
  { event: SSO_RESEAL_REQUESTED_EVENT },
  async ({ step }) => runReseal(step, "event"),
);
