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

test("ships a real stella serve round-trip smoke test and both CI entry points", () => {
  const clientRoot = join(root, "packages/stella-engine-client");
  const smoke = filesUnder(clientRoot).find((path) => {
    // The live round-trip lives in a *.smoke.test.ts file; scope discovery to
    // it so sibling unit tests that merely mention `stella serve` / `tool_result`
    // (e.g. error-path coverage) can't shadow the real smoke test.
    if (!/\.smoke\.(test|spec)\.ts$/.test(path)) return false;
    const source = readFileSync(path, "utf8");
    return /stella\s+serve/i.test(source) && /tool[_-]result/i.test(source);
  });

  expect(
    smoke,
    "expected a Stella sidecar integration test that boots `stella serve` and services reverse tool RPC",
  ).toBeDefined();

  const source = readFileSync(smoke!, "utf8");
  expect(
    source,
    "the smoke must skip cleanly when the pinned Stella binary is unavailable",
  ).toMatch(/(?:skip|skipIf|commandExists|ENOENT|not installed)/i);
  expect(
    source,
    "the smoke must exercise session open, turn, event SSE, and close",
  ).toMatch(
    /createSession[\s\S]*?(?:openEventStream|events)[\s\S]*?(?:driveTurn|turn)[\s\S]*?(?:deleteSession|close)/,
  );
  for (const field of ["seq", "call_id", "name", "input"] as const) {
    expect(
      source,
      `assert the concrete ${field} wire field so an upstream rename turns the test red`,
    ).toMatch(
      new RegExp(
        `(?:toMatchObject|toEqual|toHaveProperty|expect)[\\s\\S]{0,240}${field}`,
      ),
    );
  }
  expect(source, "the smoke must assert one terminal completion event").toMatch(
    /(?:complete|completed)[\s\S]{0,240}(?:toHaveLength\(1\)|toBe\(1\))/i,
  );

  const workflows = filesUnder(join(root, ".github/workflows"))
    .filter((path) => /\.ya?ml$/.test(path))
    .map((path) => readFileSync(path, "utf8"));
  expect(
    workflows.some((yaml) => /packages\/stella-engine-client\/\*\*/.test(yaml)),
  ).toBe(true);
  expect(
    workflows.some(
      (yaml) =>
        /schedule:/.test(yaml) && /stella/i.test(yaml) && /latest/i.test(yaml),
    ),
    "expected a scheduled workflow that runs the smoke against Stella latest",
  ).toBe(true);
});
