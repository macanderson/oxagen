/**
 * Proves that this deployment's Inngest wiring can actually run a function.
 *
 * Three things must all hold, and until this script existed nothing checked
 * any of them. Production ran for two weeks with all three broken: the app was
 * never synced, and `INNGEST_SIGNING_KEY` in SSM was byte-for-byte a
 * developer's local `signkey-test-…` while `INNGEST_EVENT_KEY` belonged to a
 * different environment. Every `inngest.send()` returned HTTP 200 with an
 * event id, so the connect wizard, the GitHub webhook receiver and the sync
 * button all reported success, and not one function ever ran.
 *
 *   1. The signing key belongs to the environment class this deployment
 *      expects (a production deploy on a `signkey-test-…` key is wrong by
 *      inspection).
 *   2. The serve endpoint syncs — Inngest learns the functions exist and which
 *      URL to call back on.
 *   3. The event key and the signing key resolve to the SAME Inngest
 *      environment. This is the one that cannot be read off a key: a canary
 *      event is sent with the event key and then looked for in the signing
 *      key's environment. An event that never arrives is the mismatch.
 *
 * Usage:
 *   pnpm inngest:verify --url https://api.oxagen.sh/api/inngest
 *
 * Reads INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY from the environment. Exits
 * non-zero, with the reason, when any of the three fails.
 */

import { inngestEnvironmentComplaint } from "../../packages/inngest-functions/src/env-check";

/** Event name for the connectivity canary. No function triggers on it. */
export const CANARY_EVENT_NAME = "ops/inngest.connectivity-canary";

const INNGEST_API = "https://api.inngest.com";
const EVENT_API = "https://inn.gs";
/** How long to wait for the canary to appear in the signing key's environment. */
const VISIBILITY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;

interface InngestEvent {
  id?: string;
  internal_id?: string;
  name?: string;
}

/**
 * True when `events` contains the canary we sent. Matching on the event id
 * rather than the name, because a previous run's canary carries the same name
 * and would make a mismatched key pair look healthy.
 */
export function canaryIsVisible(
  events: readonly InngestEvent[],
  canaryId: string,
): boolean {
  return events.some(
    (event) => event.id === canaryId || event.internal_id === canaryId,
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    fail(`${name} is not set. This check cannot run without it.`);
  }
  return value;
}

function fail(message: string): never {
  console.error(`inngest-verify: FAILED — ${message}`);
  process.exit(1);
}

function parseUrlArg(argv: readonly string[]): string {
  const index = argv.indexOf("--url");
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) {
    fail(
      "pass the serve endpoint, e.g. --url https://api.oxagen.sh/api/inngest",
    );
  }
  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Step 1 — the check that needs no network. */
function checkKeyPosture(signingKey: string): void {
  const complaint = inngestEnvironmentComplaint({
    nodeEnv: process.env.NODE_ENV ?? "",
    signingKey,
  });
  if (complaint) fail(complaint);
  console.log("inngest-verify: signing key posture ok");
}

/** Step 2 — sync the app so Inngest knows the functions and the callback URL. */
async function syncApp(url: string): Promise<void> {
  const response = await fetch(url, { method: "PUT" });
  const body = await response.text();
  if (!response.ok) {
    fail(`sync of ${url} returned ${response.status}: ${body.slice(0, 300)}`);
  }
  console.log(`inngest-verify: app synced (${body.slice(0, 200)})`);
}

/** Step 3a — send the canary with the event key. */
async function sendCanary(eventKey: string): Promise<string> {
  const response = await fetch(`${EVENT_API}/e/${eventKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: CANARY_EVENT_NAME,
      data: { sentAt: new Date().toISOString() },
    }),
  });
  const body = (await response.json()) as { ids?: string[] };
  const id = body.ids?.[0];
  if (!response.ok || !id) {
    fail(
      `the event API rejected the canary (${response.status}). INNGEST_EVENT_KEY is not a usable event key.`,
    );
  }
  console.log(`inngest-verify: canary sent (${id})`);
  return id;
}

/** Step 3b — look for it in the environment the signing key authenticates to. */
async function awaitCanaryVisible(
  signingKey: string,
  canaryId: string,
): Promise<void> {
  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(`${INNGEST_API}/v1/events?limit=50`, {
      headers: { Authorization: `Bearer ${signingKey}` },
    });
    if (response.status === 401 || response.status === 403) {
      fail(
        "INNGEST_SIGNING_KEY was rejected by the Inngest API. It is not a valid signing key.",
      );
    }
    if (response.ok) {
      const body = (await response.json()) as { data?: InngestEvent[] };
      if (canaryIsVisible(body.data ?? [], canaryId)) {
        console.log(
          "inngest-verify: canary is visible in the signing key's environment — keys agree",
        );
        return;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  fail(
    `the canary (${canaryId}) was accepted by the event API but never appeared in the environment ` +
      "INNGEST_SIGNING_KEY authenticates to. The two keys belong to different Inngest environments, " +
      "so events land where no function is registered and nothing will ever run. Set both keys from " +
      "the same Inngest environment and redeploy.",
  );
}

async function main(): Promise<void> {
  const url = parseUrlArg(process.argv.slice(2));
  const eventKey = requireEnv("INNGEST_EVENT_KEY");
  const signingKey = requireEnv("INNGEST_SIGNING_KEY");

  checkKeyPosture(signingKey);
  await syncApp(url);
  const canaryId = await sendCanary(eventKey);
  await awaitCanaryVisible(signingKey, canaryId);

  console.log(
    "inngest-verify: OK — events reach the environment the functions live in",
  );
}

// Guarded so the pure helpers above can be imported by the test without the
// script trying to talk to Inngest.
if (process.env.VITEST === undefined) {
  main().catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
