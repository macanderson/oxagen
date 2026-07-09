// tool-registry.test.ts — config-derived parity guard.
//
// Computes the expected set of MCP tool names by filtering the canonical
// `contracts` array from @oxagen/oxagen/contracts to those whose `surfaces`
// includes "mcp". Compares that set against the union of `metadata.name`
// values exported by every tool file in this directory.
//
// If a contract gains the "mcp" surface without a corresponding tool file,
// or if a tool file's metadata.name diverges from the contract name, this
// test fails — no stale or missing tools can ship silently.
//
// No hardcoded count; the expected set is derived from the contracts array.
//
// Tool files auto-register by directory scan + dynamic import rather than a
// hand-maintained import list. The old hand-list drifted from the actual
// tool files repeatedly (missing a2a.card.get siblings, agent.trace.get,
// agent.execution.list, conversation.attachment.add, agent.sandbox.files.list
// — a new tool file shipping without a matching import here was invisible to
// this test, defeating its purpose) — auto-discovery makes that class of
// drift structurally impossible.
//
// (import.meta.glob would be the more idiomatic Vite pattern here, but its
// ambient types aren't referenced by this package's tsconfig and adding them
// risks unrelated fallout — plain dynamic import() needs no extra types.)
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it, expect } from "vitest";
import { contracts } from "@oxagen/oxagen/contracts";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

// Every ".ts" file in this directory is a tool module and must export
// `metadata`, EXCEPT test files and files prefixed "_" (shared test-only
// helpers, e.g. _schema-test-helpers.ts, that are not themselves tools).
const toolModuleNames = readdirSync(TOOLS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .filter((f) => !f.endsWith(".test.ts"))
  .filter((f) => !f.startsWith("_"))
  .map((f) => f.replace(/\.ts$/, ""))
  .sort();

const toolModules: unknown[] = await Promise.all(
  toolModuleNames.map((name) => import(/* @vite-ignore */ `./${name}`)),
);

const allToolMetadata = toolModules.map((mod, i) => {
  const metadata = (mod as { metadata?: unknown }).metadata;
  if (!metadata) {
    throw new Error(
      `${toolModuleNames[i]}.ts has no "metadata" export — every file in ` +
        `apps/mcp/src/tools/ must export tool metadata, or be prefixed "_" ` +
        `if it is a shared non-tool helper.`,
    );
  }
  return metadata as { name: string };
});

// ── Derive expected tool set from contracts ───────────────────────────────────

/** Names derived from the contracts array for the "mcp" surface (sorted). */
const contractMcpNames = (
  contracts as ReadonlyArray<{ name: string; surfaces: readonly string[] }>
)
  .filter((c) => c.surfaces.includes("mcp"))
  .map((c) => c.name)
  .sort();

/** Names as declared in the tool metadata (sorted). */
const registeredToolNames = allToolMetadata.map((m) => m.name).sort();

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tool-registry parity", () => {
  it("registered tool names match the mcp-surfaced contracts exactly", () => {
    expect(registeredToolNames).toEqual(contractMcpNames);
  });

  it("each tool metadata.name matches the corresponding contract name (no copy-paste drift)", () => {
    // Build a map: contract name -> contract for O(1) lookup.
    const contractByName = new Map(
      (
        contracts as ReadonlyArray<{
          name: string;
          surfaces: readonly string[];
        }>
      )
        .filter((c) => c.surfaces.includes("mcp"))
        .map((c) => [c.name, c]),
    );

    for (const meta of allToolMetadata) {
      const contract = contractByName.get(meta.name);
      expect(
        contract,
        `Tool metadata has name "${meta.name}" but no matching mcp-surfaced contract exists`,
      ).toBeDefined();
      expect(meta.name).toBe(contract!.name);
    }
  });

  it("no two tool files declare the same metadata.name", () => {
    const nameSet = new Set<string>();
    for (const meta of allToolMetadata) {
      expect(
        nameSet.has(meta.name),
        `Duplicate tool metadata name: "${meta.name}"`,
      ).toBe(false);
      nameSet.add(meta.name);
    }
  });

  it("has at least one registered tool (sanity: registry is non-empty)", () => {
    expect(allToolMetadata.length).toBeGreaterThan(0);
  });
});
