/**
 * gen-capability-schemas.ts — generate per-capability input/output JSON Schema
 * documentation for every registered contract.
 *
 * The Zod-to-JSON-Schema conversion lives in `lib/zod-json-schema.ts`. It walks
 * the Zod v3 `_def` tree with no new dependency, so the output is deterministic
 * and the gate can run it.
 *
 *   pnpm tsx tools/scripts/gen-capability-schemas.ts
 *
 * Outputs:
 *   docs/capabilities/schemas/<capability>.json   (one per capability)
 *   docs/capabilities/schemas/_index.json         (machine-readable catalog)
 *   docs/capabilities/schemas/README.md           (human summary)
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
// Importing the package root runs its `import "./contracts.generated"` side
// effect, registering every contract before we enumerate them.
import {
  listCapabilities,
  getCapabilityChain,
  getRenderHint,
} from "@oxagen/oxagen";
import { toJsonSchema, type ZodLike } from "./lib/zod-json-schema";

// ── Generate ──────────────────────────────────────────────────────────────────

const outDir = join(process.cwd(), "docs", "capabilities", "schemas");
mkdirSync(outDir, { recursive: true });

/**
 * `--check` verifies the committed artifact matches what this script produces,
 * instead of rewriting it.
 *
 * These files are the published machine-readable contract: an external consumer
 * validates its batches against them. Nothing kept them in step, so they went
 * stale silently — `ingest_tacho_events.json` carried `user_email_digest` on 45
 * of its 46 event branches, and the missing one was `proof.observed`, so a
 * legacy sealed event of that kind would have been rejected by a consumer while
 * the real ingest validator accepted it (#3072). Being 98% regenerated reads
 * exactly like being regenerated, from inside the repo; from outside it reads
 * as a broken contract. Seven other capabilities had drifted too, from contract
 * changes that landed on `main` without a regeneration.
 */
const checkOnly = process.argv.includes("--check");
const stale: string[] = [];

/** Every file this run is responsible for, so orphans can be spotted below. */
const expected = new Set<string>();

function emit(file: string, contents: string): void {
  expected.add(file);
  const path = join(outDir, file);
  if (!checkOnly) {
    writeFileSync(path, contents);
    return;
  }
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== contents) stale.push(file);
}

/**
 * Files on disk that no contract accounts for.
 *
 * Iterating the contracts answers "is every generated file current?". It
 * cannot answer "is every generated file WANTED?" — a capability that is
 * deleted or renamed is simply not visited, so its `.json` is never compared,
 * never removed and never reported, and the published directory keeps
 * advertising a capability that no longer exists. A synchronisation check that
 * walks the source and never enumerates the destination can only find drift in
 * one direction. ADR-025's file-path realignment makes renames an ongoing
 * activity here, so this is a live shape rather than a hypothetical: it found
 * `list_workspace_members.json`, absorbed into `list_members` by Appendix E,
 * still published months later.
 *
 * `--check` reports; a plain run deletes. A check that edits the tree it is
 * auditing cannot be run twice with the same meaning.
 */
function orphans(): string[] {
  return readdirSync(outDir)
    .filter((file) => file.endsWith(".json") || file.endsWith(".md"))
    .filter((file) => !expected.has(file))
    .sort();
}

const caps = listCapabilities().sort((a, b) => a.name.localeCompare(b.name));
const index: Array<Record<string, unknown>> = [];

for (const cap of caps) {
  const chain = getCapabilityChain(cap.name);
  const renderHint = getRenderHint(cap.name);
  const doc = {
    name: cap.name,
    domain: cap.domain,
    description: cap.description,
    mode: cap.mode,
    surfaces: cap.surfaces ?? ["api", "mcp"],
    sensitivity: cap.sensitivity,
    agent: cap.agent ?? null,
    chain: {
      produces: chain.produces,
      consumes: chain.consumes,
      chainHints: chain.chainHints,
    },
    render: renderHint ?? null,
    input: toJsonSchema(cap.input as unknown as ZodLike),
    output: toJsonSchema(cap.output as unknown as ZodLike),
  };
  emit(`${cap.name}.json`, JSON.stringify(doc, null, 2) + "\n");
  index.push({
    name: cap.name,
    domain: cap.domain,
    surfaces: doc.surfaces,
    component: renderHint?.componentId ?? null,
    produces: chain.produces,
    consumes: chain.consumes,
  });
}

emit(
  "_index.json",
  JSON.stringify(
    { generatedCount: caps.length, capabilities: index },
    null,
    2,
  ) + "\n",
);

const byDomain = new Map<string, string[]>();
for (const cap of caps) {
  const list = byDomain.get(cap.domain) ?? [];
  list.push(cap.name);
  byDomain.set(cap.domain, list);
}
const readme = [
  `# Capability JSON Schemas`,
  ``,
  `Auto-generated by \`tools/scripts/gen-capability-schemas.ts\`. One \`<capability>.json\``,
  `per capability with its input + output JSON Schema, chain metadata`,
  `(produces/consumes/chainHints), and chat render component. Do not edit by hand.`,
  ``,
  `**${caps.length} capabilities** across ${byDomain.size} domains.`,
  ``,
  ...[...byDomain.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([domain, names]) =>
        `- **${domain}** (${names.length}): ${names.join(", ")}`,
    ),
  ``,
].join("\n");
emit("README.md", readme);

const extra = orphans();

if (checkOnly) {
  const problems: string[] = [];
  if (stale.length > 0) {
    problems.push(
      `${stale.length} file(s) behind the contracts:\n` +
        stale.map((f) => `  ${f}`).join("\n"),
    );
  }
  if (extra.length > 0) {
    problems.push(
      `${extra.length} file(s) no contract accounts for:\n` +
        extra.map((f) => `  ${f}`).join("\n"),
    );
  }
  if (problems.length > 0) {
    console.error(
      `docs/capabilities/schemas does not match the contracts.\n\n` +
        problems.join("\n\n") +
        `\n\nRun \`pnpm docs:schemas\` and commit the result. These files are the` +
        `\npublished schema other people validate against: a stale one rejects` +
        `\ntraffic the real validator accepts, and an orphaned one advertises a` +
        `\ncapability that no longer exists.`,
    );
    process.exit(1);
  }
  console.log(
    `docs/capabilities/schemas matches ${caps.length} capability contracts`,
  );
} else {
  for (const file of extra) rmSync(join(outDir, file), { force: true });
  console.log(
    `Wrote ${caps.length} capability schema docs to docs/capabilities/schemas/` +
      (extra.length > 0
        ? `\nRemoved ${extra.length} orphaned file(s): ${extra.join(", ")}`
        : ""),
  );
}
