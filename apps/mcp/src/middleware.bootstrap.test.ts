// middleware.bootstrap.test.ts — startup-wiring guard for the MCP surface.
//
// src/middleware.ts is the only module in this app that wires the kernel's
// gates. It cannot be imported here: its module scope awaits
// assertRlsConnectionSafe() and constructs a Postgres client, so importing it
// in a unit run would need the full infra stack. That is also why it is absent
// from the coverage `include` list in vitest.config.ts.
//
// Scope note: this guard proves the calls are present in the source, not that
// they run on every transport. xmcp loads a middleware module only in its HTTP
// runtime, so the `start:stdio` entrypoint in package.json boots with none of
// the wiring below (and with no handlers registered, so every tool would fail
// `no_handler`). Nothing in this repo runs that script; if stdio is ever put
// into service, its bootstrap needs its own home and its own guard.
//
// Every wiring call it makes is silent-on-omission — the kernel keeps
// dispatching without an IAM check, a billing admission gate, an entitlement
// gate, or an audit trail if the corresponding bootstrap is dropped. Nothing
// throws and no test fails. So this guard asserts on the source text instead:
// it is the cheapest check that fails when a required call is deleted.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./middleware.ts", import.meta.url)),
  "utf8",
);

// Each entry: the call that must appear, and what silently breaks without it.
const REQUIRED_STARTUP_CALLS: ReadonlyArray<readonly [string, string]> = [
  ["assertRlsConnectionSafe(", "tenant RLS policies become dead weight"],
  ["bootstrapIAMRuntime(", "every capability dispatches without an IAM check"],
  ["bootstrapBillingRuntime(", "suspended / zero-balance orgs are not refused"],
  [
    "bootstrapEntitlementRuntime(",
    "plugin-owned capabilities run for orgs that never installed the plugin",
  ],
  ["setSecurityEventEmitter(", "the SOC2 CC6/CC7 audit trail is not written"],
  ["initTracer(", "OpenTelemetry spans are never exported"],
];

describe("mcp middleware startup wiring", () => {
  for (const [call, consequence] of REQUIRED_STARTUP_CALLS) {
    it(`calls ${call}) at module scope — without it, ${consequence}`, () => {
      expect(source).toContain(call);
    });
  }

  it("registers the foundation and agent handler bundles", () => {
    // Without these side-effect imports the kernel throws `no_handler` for
    // every tool, because no other module in apps/mcp imports them.
    expect(source).toContain('import "@oxagen/handlers/register"');
    expect(source).toContain('import "@oxagen/agent/register"');
  });

  it("keeps the startup wiring at module scope, not inside the middleware fn", () => {
    // xmcp exposes no lifecycle hook, so module scope is the only location
    // guaranteed to run on cold start. If a bootstrap call ever moved below
    // the exported middleware, it would run per-request (or not at all).
    const exportIndex = source.indexOf("export default apiKeyAuthMiddleware");
    expect(exportIndex).toBeGreaterThan(-1);
    for (const [call] of REQUIRED_STARTUP_CALLS) {
      expect(source.indexOf(call)).toBeLessThan(exportIndex);
    }
  });
});
