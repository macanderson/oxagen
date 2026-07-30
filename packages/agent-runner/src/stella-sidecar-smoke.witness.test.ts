/**
 * Witness test: guards that the Stella sidecar smoke test stays *meaningful*.
 *
 * It greps the sibling package's source rather than importing it, because what
 * it protects is not behaviour but the continued existence of a specific kind
 * of coverage — a live round trip against a real engine binary, plus the CI
 * entry points that run it. Deleting the smoke test, hollowing out its
 * assertions, or dropping a workflow all turn this red.
 *
 * ## Rewritten for oxagen #1132
 *
 * The previous revision asserted the *wrong contract*, and that is worth
 * recording because it is the trap this file exists to avoid. It demanded a
 * `seq` field (stella-serve emits no sequence numbers at all), a
 * `createSession` -> `openEventStream` -> `driveTurn` -> `deleteSession`
 * sequence (there is no session resource and no DELETE route), and the literal
 * phrase `stella serve` (the binary is `stella-serve`; the subcommand has never
 * existed). A witness that pins a fictional contract does not protect
 * coverage — it obstructs correcting it. The assertions below name only
 * properties verified against a running stella-serve 0.6.2.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test("ships a real stella-serve round-trip smoke test and both CI entry points", () => {
  const clientRoot = join(root, "packages/stella-engine-client");
  const smoke = filesUnder(clientRoot).find((path) => {
    // The live round-trip lives in a *.smoke.test.ts file; scope discovery to
    // it so sibling unit tests that merely mention stella-serve / tool-result
    // (e.g. error-path coverage) can't shadow the real smoke test.
    if (!/\.smoke\.(test|spec)\.ts$/.test(path)) return false;
    const source = readFileSync(path, "utf8");
    return /stella-serve/i.test(source) && /tool[_-]result/i.test(source);
  });

  expect(
    smoke,
    "expected a Stella sidecar integration test that boots `stella-serve` and services reverse RPC",
  ).toBeDefined();

  const source = readFileSync(smoke!, "utf8");
  expect(
    source,
    "the smoke must skip cleanly when the Stella binary is unavailable",
  ).toMatch(/(?:skip|skipIf|commandExists|ENOENT|not installed|not found)/i);

  // The real drive sequence: create a turn, stream its frames, answer the
  // engine's model call, answer its tool call. A smoke test missing either
  // reverse-RPC leg cannot complete a turn, which is the defect #1132 found.
  expect(
    source,
    "the smoke must create a turn, stream frames, and answer BOTH reverse-RPC kinds",
  ).toMatch(
    /(?:createTurn|runTurn)[\s\S]*?onProviderRequest[\s\S]*?onToolRequest/,
  );

  // Concrete wire fields, so an upstream rename turns the smoke red. `seq` is
  // deliberately absent from this list: the server does not emit one.
  for (const field of [
    "provider_id",
    "tool_calls",
    "tool_results",
    "call_id",
    "cost_usd",
  ] as const) {
    expect(
      source,
      `assert the concrete ${field} wire field so an upstream rename turns the test red`,
    ).toMatch(
      new RegExp(
        `(?:toMatchObject|toEqual|toHaveProperty|toBe|expect)[\\s\\S]{0,400}${field}`,
      ),
    );
  }

  // The multi-step property: a turn that only ever makes one model call is not
  // an agent loop, and would pass a weaker assertion set while proving nothing
  // about the engine's orchestration.
  expect(
    source,
    "the smoke must assert the engine made a SECOND model call after the tool result",
  ).toMatch(/providerCalls[\s\S]{0,200}toBe\(2\)/);

  // The terminal frame, and that it settled as completed rather than aborted.
  expect(
    source,
    "the smoke must assert the turn reached a `completed` terminal outcome",
  ).toMatch(/outcome\.status[\s\S]{0,120}completed/);

  const workflows = filesUnder(join(root, ".github/workflows"))
    .filter((path) => /\.ya?ml$/.test(path))
    .map((path) => readFileSync(path, "utf8"));
  expect(
    workflows.some((yaml) => /packages\/stella-engine-client\/\*\*/.test(yaml)),
    "expected a path-filtered workflow for the sidecar package",
  ).toBe(true);
  expect(
    workflows.some(
      (yaml) =>
        /schedule:/.test(yaml) && /stella/i.test(yaml) && /latest/i.test(yaml),
    ),
    "expected a scheduled workflow that runs the smoke against Stella latest",
  ).toBe(true);
  // Both jobs must obtain a binary that actually serves. Stella's release
  // tarball ships `stella-cli` only — `make build-release` builds `-p
  // stella-cli` — so a workflow that downloads a release and expects `serve`
  // gets a binary without it and skips forever. Building the crate is the only
  // way to get one today.
  expect(
    workflows.filter((yaml) => /cargo build[^\n]*stella-serve/.test(yaml))
      .length,
    "both sidecar workflows must BUILD stella-serve; the release tarball does not contain it",
  ).toBeGreaterThanOrEqual(2);
});
