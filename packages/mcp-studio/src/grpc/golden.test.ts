// golden.test.ts: the ledger fixture imports to its goldens, from its .proto
// file and from server reflection. Each golden pins every tool's inputSchema,
// outputSchema, description, and request template, with the listed methods
// and the notes. ledger-reflection.proto pins the .proto text import prints
// from the reflection result.
//
// scripts/write-grpc-expected.ts writes the goldens. A golden changes only
// when the importer's output is meant to change, so a diff here is either a
// regression or a golden to rewrite and review.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatJson } from "../contract/json";
import { importGrpc } from "./index";
import { FIXTURES, GOLDENS, GRPC_EXPECTED, REFLECTED_PROTO, goldenValue, ledgerReflection } from "./__tests__/golden";

/**
 * Checks the text against the golden file. On a difference, it also prints
 * the text as one JSON string, because vitest cuts a long diff and a CI run
 * cannot write the file.
 */
function expectGolden(path: string, actual: string): void {
  const golden = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (golden !== actual) console.log(`golden ${path.slice(FIXTURES.length)} ${JSON.stringify(actual)}`);
  expect(actual).toBe(golden);
}

describe("the gRPC goldens", () => {
  it.each(Object.keys(GOLDENS))("%s imports to its golden", async (name) => {
    const input = GOLDENS[name];
    if (input === undefined) throw new Error(`No input for the golden ${name}.`);
    const result = await importGrpc(input());
    expectGolden(`${GRPC_EXPECTED}${name}.json`, formatJson(goldenValue(result)));
  });

  it("prints the reflection result as ledger-reflection.proto", async () => {
    const result = await importGrpc(ledgerReflection());
    expect(result.files.map((file) => file.path)).toStrictEqual(["proto/ledger.proto"]);
    expectGolden(REFLECTED_PROTO, result.files[0]?.text ?? "");
  });
});
