/**
 * agent-register-invariant.test.ts — structural guard for kernel handler
 * registration.
 *
 * The `agent.*` capabilities are implemented in a SEPARATE package
 * (`@oxagen/agent`) from the foundation handlers (`@oxagen/handlers`). Each
 * package exposes a side-effect "register" module that binds its handlers into
 * the shared kernel at module-eval time:
 *
 *   import "@oxagen/handlers/register";  // foundation capabilities
 *   import "@oxagen/agent/register";     // agent.* capabilities
 *
 * Any module that `invoke()`s an `agent.*` capability MUST import
 * `@oxagen/agent/register`, or the kernel throws at runtime:
 *
 *   No handler registered for capability "agent.approval.resolve".
 *   Did its package's register module run?
 *
 * This bug class is invisible to ordinary unit tests because those mock
 * `@oxagen/oxagen` (invoke) and stub the register modules — the real
 * registration path is never exercised. So we assert the invariant
 * structurally against the source tree instead. This caught two server-action
 * modules (`shell-actions.ts`, `ask/actions.ts`) that invoked agent.*
 * capabilities while importing only the foundation register.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

// ADR-025 renamed capabilities to bare verb_noun snake_case (e.g.
// "list_sandboxes"), so a name-prefix regex can no longer identify "agent
// package" capabilities. Derive the exact set from the package's own LOADERS
// map instead — `agentHandlerNames` is the single source of truth for which
// capability names only @oxagen/agent/register can bind.
const IMPORTS_AGENT_REGISTER = /["']@oxagen\/agent\/register["']/;
// Legacy dotted form kept as belt-and-braces for any straggler literals.
const INVOKES_DOTTED_AGENT_CAPABILITY = /invoke\(\s*["']agent\./;

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function invokesAgentCapability(
  flattened: string,
  names: readonly string[],
): boolean {
  if (INVOKES_DOTTED_AGENT_CAPABILITY.test(flattened)) return true;
  // `flattened` collapses runs of whitespace to a SINGLE SPACE, so a
  // multi-line `invoke(\n  "list_agent_tools",` becomes `invoke( "…"` — with a
  // space after the paren. Matching the bare substring `invoke("name"` therefore
  // silently skipped every multi-line call site (this is how the missing
  // @oxagen/agent/register import in lib/workbench/tools.ts went unnoticed).
  // Allow the optional space instead of relying on the call being one line.
  return names.some((name) =>
    new RegExp(`invoke\\(\\s*["']${escapeForRegExp(name)}["']`).test(flattened),
  );
}

describe("agent handler registration invariant", () => {
  const files = collectSourceFiles(SRC_DIR);

  it("scans a non-empty source tree", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every module that invokes an agent-package capability imports @oxagen/agent/register", async () => {
    const { agentHandlerNames } = await import("@oxagen/agent/handlers");
    expect(agentHandlerNames.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // Collapse whitespace so multi-line `invoke(\n  "list_sandboxes")` matches.
      const flattened = source.replace(/\s+/g, " ");
      if (
        invokesAgentCapability(flattened, agentHandlerNames) &&
        !IMPORTS_AGENT_REGISTER.test(source)
      ) {
        offenders.push(relative(SRC_DIR, file));
      }
    }
    expect(
      offenders,
      `These modules invoke an agent-package capability but never import "@oxagen/agent/register", ` +
        `so the kernel has no handler bound at runtime:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
