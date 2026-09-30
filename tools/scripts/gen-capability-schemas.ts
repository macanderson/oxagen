/**
 * gen-capability-schemas.ts — generate per-capability input/output JSON Schema
 * documentation for every registered contract.
 *
 *   pnpm docs:schemas            regenerate and write the directory, deleting
 *                                files no contract produces.
 *   pnpm docs:schemas --check    regenerate in memory and exit 1, naming every
 *                                stale or orphaned file, if the committed
 *                                directory differs. Writes nothing.
 *
 * Outputs:
 *   docs/capabilities/schemas/<capability>.json   (one per capability)
 *   docs/capabilities/schemas/_index.json         (machine-readable catalog)
 *   docs/capabilities/schemas/README.md           (human summary)
 *
 * Why `--check` exists. These files are the published machine-readable
 * contract: an external consumer validates its batches against them. Nothing
 * kept them in step with the contracts, so they went stale silently.
 * `ingest_tacho_events.json` carried `user_email_digest` on 45 of its 46 event
 * branches, and the missing one was `proof.observed`, so a consumer would have
 * rejected a legacy sealed event of that kind while the real ingest validator
 * accepted it (#3072). Being 98% regenerated reads exactly like being
 * regenerated from inside the repo, and like a broken contract from outside
 * it. Seven other capabilities had drifted too, from contract changes that
 * landed on `main` without a regeneration. The check also lists the directory,
 * because walking the contracts alone never visits a deleted or renamed
 * capability, and `list_workspace_members.json` stayed published months after
 * ADR-025 absorbed it into `list_members` (#3173).
 *
 * Where it runs: `pnpm check:contracts` ends with `docs:schemas:check`, which
 * runs `--check`, and `check:contracts` runs in the pipeline `checks` job and
 * in `pnpm gate` (#3148). `packages/database/src/storage-manifest/cli.ts` is the precedent
 * this follows.
 *
 * No output holds a count of the whole capability set, because two branches
 * that each add a capability would both rewrite it and always conflict
 * (ADR-216, #3691). After a merge, regenerate from the merged tree.
 *
 * The rendering lives in `lib/capability-schema-docs.ts` and the Zod-to-JSON-
 * Schema conversion in `lib/zod-json-schema.ts`, so tests can exercise both
 * without running this script. This file only reads the registry and does the
 * I/O.
 */
import { join } from "node:path";
// Importing the package root runs its `import "./contracts.generated"` side
// effect, registering every contract before we enumerate them.
import {
  listCapabilities,
  getCapabilityChain,
  getRenderHint,
} from "@oxagen/oxagen";
import {
  diffSchemaDocs,
  formatCheckReport,
  renderSchemaDocs,
  writeSchemaDocs,
  type CapabilityDocSource,
} from "./lib/capability-schema-docs";
import type { ZodLike } from "./lib/zod-json-schema";

const outDir = join(process.cwd(), "docs", "capabilities", "schemas");
const checkOnly = process.argv.includes("--check");

const sources: CapabilityDocSource[] = listCapabilities().map((cap) => {
  const chain = getCapabilityChain(cap.name);
  return {
    name: cap.name,
    domain: cap.domain,
    description: cap.description,
    mode: cap.mode,
    surfaces: cap.surfaces,
    sensitivity: cap.sensitivity,
    agent: cap.agent,
    input: cap.input as unknown as ZodLike,
    output: cap.output as unknown as ZodLike,
    chain: {
      produces: chain.produces,
      consumes: chain.consumes,
      chainHints: chain.chainHints,
    },
    render: getRenderHint(cap.name) ?? null,
  };
});

const files = renderSchemaDocs(sources);

if (checkOnly) {
  const report = formatCheckReport(diffSchemaDocs(files, outDir));
  if (report !== null) {
    console.error(report);
    process.exit(1);
  }
  console.log(
    `docs/capabilities/schemas matches ${sources.length} capability contracts`,
  );
} else {
  const removed = writeSchemaDocs(files, outDir);
  console.log(
    `Wrote ${sources.length} capability schema docs to docs/capabilities/schemas/` +
      (removed.length > 0
        ? `\nRemoved ${removed.length} orphaned file(s): ${removed.join(", ")}`
        : ""),
  );
}
