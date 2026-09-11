#!/usr/bin/env tsx
/**
 * check-inngest-senders.ts — every Inngest trigger must have a sender.
 *
 * A durable function subscribes to an event name. No type connects that name to
 * the code that sends it, and none can: the client's event schema says what a
 * valid event looks like, never that anything constructs one. So a trigger on
 * an event nobody sends compiles, lints, tests and deploys, then sits in the
 * registered function list looking like a live retry path.
 *
 * That is #2823's third finding. `chat.persist-stream` subscribes to
 * `chat/message.streamed` with `retries: 3`, its spec describes terminal
 * persistence for a streamed assistant turn, and no code path has ever sent
 * the event — so the durability it advertises has never once been exercised.
 * The two `stripe.sync-*` functions are the same shape: the webhook route
 * handles those Stripe events inline through `processStripeEvent` instead.
 *
 * A trigger with no sender is worse than a missing function: the missing one
 * is visible, and this one reads as delivered work.
 *
 * Run via `pnpm check:inngest-senders`; wired into `pnpm gate`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { argv, exit, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Where triggers are declared. */
const TRIGGER_ROOT = join(ROOT, "packages/inngest-functions/src");

/** Where a sender may live. */
const SENDER_ROOTS = ["apps", "packages", "tools"].map((d) => join(ROOT, d));

/**
 * Inngest emits its own lifecycle events into the same namespace — a function
 * failing produces `inngest/function.failed`, which is what the on-failure
 * companion in create-function.ts and observability.capture-failure subscribe
 * to. The platform is the sender, so no code in this repository sends them and
 * none should. This is a rule about who emits the namespace, not a list of
 * events excused from the check.
 */
const PLATFORM_EVENT_PREFIX = "inngest/";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  ".vercel",
  ".xmcp",
  "coverage",
  "out",
  "build",
  "e2e",
  "__tests__",
]);

/** Where one trigger was declared. */
export interface Trigger {
  event: string;
  /** `path:line`, relative to the repository root. */
  location: string;
}

/** Source files a scan should read: TypeScript, excluding tests. */
export function sourceFiles(dir: string, results: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) sourceFiles(full, results);
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name))
      results.push(full);
  }
  return results;
}

/**
 * Event names this file subscribes to: the `{ event: "…" }` trigger literal
 * `createFunction` takes, and the same shape `step.waitForEvent` parks on —
 * a waited-for event needs a sender for exactly the same reason.
 */
export function triggersIn(source: string, relPath: string): Trigger[] {
  const found: Trigger[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(/\bevent:\s*"([^"]+)"/g)) {
      found.push({ event: m[1]!, location: `${relPath}:${i + 1}` });
    }
  }
  return found;
}

/**
 * Event names this file sends.
 *
 * The name literal and the call that ships it are matched per file rather than
 * per line: senders build the payload object first and send it several lines
 * later (`apps/api/src/routes/v1/github-webhook.ts` builds an array and sends
 * it at the end), and a batch send names no event at the call site at all.
 * Requiring the file to carry a send call is what keeps a bare `name: "…"`
 * type annotation from reading as a sender.
 */
export function sendersIn(source: string): string[] {
  if (!/\.send\(|\bsendEvent\(/.test(source)) return [];
  return [...source.matchAll(/\bname:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

/** Triggers whose event nothing sends. */
export function orphans(
  triggers: readonly Trigger[],
  sent: ReadonlySet<string>,
): Trigger[] {
  return triggers.filter(
    (t) => !t.event.startsWith(PLATFORM_EVENT_PREFIX) && !sent.has(t.event),
  );
}

function main(): void {
  const triggers: Trigger[] = [];
  for (const file of sourceFiles(TRIGGER_ROOT)) {
    triggers.push(
      ...triggersIn(readFileSync(file, "utf8"), relative(ROOT, file)),
    );
  }

  // An empty trigger set would pass silently while proving nothing — the same
  // shape of lie this guard exists to catch. The functions directory is the
  // durable-function surface; if it yields no trigger, the parser has lost the
  // shape it reads, not the repository its functions.
  if (triggers.length === 0) {
    stdout.write(
      'check:inngest-senders — no `{ event: "…" }` trigger could be parsed out of ' +
        `${relative(ROOT, TRIGGER_ROOT)}. The parser reads that literal; restore ` +
        "it or update triggersIn(). Refusing to report a pass it cannot prove.\n",
    );
    exit(1);
  }

  const sent = new Set<string>();
  for (const root of SENDER_ROOTS) {
    for (const file of sourceFiles(root)) {
      for (const name of sendersIn(readFileSync(file, "utf8"))) sent.add(name);
    }
  }

  const dead = orphans(triggers, sent);

  if (dead.length > 0) {
    stdout.write(
      `check:inngest-senders — ${dead.length} trigger(s) subscribe to an event ` +
        `nothing in this repository sends:\n` +
        dead.map((d) => `  ${d.event}\n    ${d.location}\n`).join("") +
        `\nThe function is registered and will never run. Send the event from ` +
        `the code path that should fire it, or delete the function.\n`,
    );
    exit(1);
  }

  stdout.write(
    `check:inngest-senders — ${triggers.length} triggers, every event sent ` +
      `somewhere in the tree.\n`,
  );
}

// pathToFileURL, not string concatenation: a repo path containing a space or a
// non-ASCII character percent-encodes in `import.meta.url` but not in argv[1],
// and the mismatch would make this guard a silent no-op that exits 0.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) main();
