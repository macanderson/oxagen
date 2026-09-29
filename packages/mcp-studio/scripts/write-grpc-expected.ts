// write-grpc-expected.ts: writes what importGrpc (M3) returns for the ledger
// fixture, so the golden tests pin it.
//
//   pnpm exec tsx packages/mcp-studio/scripts/write-grpc-expected.ts
//
// For each input in GOLDENS (ledger.proto read as a file, and the same
// service as server reflection returns it), it writes
// fixtures/expected/grpc/<name>.json. It also writes ledger-reflection.proto,
// the .proto text import prints from the reflection result.
//
// Rerun it after a change to the importer, then read the diff. A golden
// changes only when the importer's output is meant to change.
import { mkdirSync, writeFileSync } from "node:fs";
import { formatJson } from "../src/contract/json";
import { importGrpc } from "../src/grpc";
import { GOLDENS, GRPC_EXPECTED, REFLECTED_PROTO, goldenValue, ledgerReflection } from "../src/grpc/__tests__/golden";

mkdirSync(GRPC_EXPECTED, { recursive: true });
for (const [name, input] of Object.entries(GOLDENS)) {
  const result = await importGrpc(input());
  writeFileSync(`${GRPC_EXPECTED}${name}.json`, formatJson(goldenValue(result)));
  console.log(`wrote fixtures/expected/grpc/${name}.json: ${result.tools.length} tools, ${result.notes.length} notes`);
}
const [printed] = (await importGrpc(ledgerReflection())).files;
if (printed === undefined) throw new Error("Import printed no file from the ledger reflection result.");
writeFileSync(REFLECTED_PROTO, printed.text);
console.log("wrote fixtures/expected/grpc/ledger-reflection.proto");
