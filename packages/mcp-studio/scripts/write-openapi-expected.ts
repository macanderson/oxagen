// write-openapi-expected.ts: writes what importOpenApi (M1) returns for each
// OpenAPI fixture, so the golden tests pin it.
//
//   pnpm exec tsx packages/mcp-studio/scripts/write-openapi-expected.ts
//
// For each entry of fixtures/openapi (a YAML file, or a folder whose entry
// is openapi.yaml), it writes fixtures/expected/openapi/<name>.json. Each
// golden holds the whole ImportResult, except large.json, which holds a
// summary (src/openapi/__tests__/golden.ts says what).
//
// Rerun it after a change to the importer, then read the diff. A golden
// changes only when the importer's output is meant to change.
import { mkdirSync, writeFileSync } from "node:fs";
import { formatJson } from "../src/contract/json";
import { importOpenApi } from "../src/openapi";
import {
  OPENAPI_EXPECTED,
  fixtureInput,
  fixtureNames,
  goldenStem,
  goldenValue,
} from "../src/openapi/__tests__/golden";

mkdirSync(OPENAPI_EXPECTED, { recursive: true });
for (const name of fixtureNames()) {
  const result = await importOpenApi(fixtureInput(name));
  const stem = goldenStem(name);
  writeFileSync(`${OPENAPI_EXPECTED}${stem}.json`, formatJson(goldenValue(stem, result)));
  console.log(`wrote fixtures/expected/openapi/${stem}.json: ${result.tools.length} tools, ${result.notes.length} notes`);
}
