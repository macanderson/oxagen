// audit-coverage.test.ts — SOC2 audit-trail invariant guard.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SOC2 BOUNDARY THIS TEST ENFORCES
// ─────────────────────────────────────────────────────────────────────────────
// Every capability invocation is already audited generically by the kernel: each
// call through invoke() emits a `capability.invoke_allowed` / `_denied` /
// `_error` security event (the SECURITY_EVENT_TYPES "Capability authz" group).
// That kernel audit covers WHO invoked WHAT and whether it was permitted, for
// every mutating handler, with no per-handler code.
//
// On top of that baseline, a SMALL set of privileged-mutation domains warrant a
// DOMAIN-SPECIFIC audit row (e.g. `api_key.revoked`, `org.member_removed`,
// `billing.plan_changed`) so an auditor can answer questions like "show me every
// API-key revocation" without reconstructing them from generic invoke logs. SOC2
// CC6.1/CC6.2/CC6.3/CC6.8 (logical access + change management) hinge on these.
//
// This test does NOT force all 64 mutating handlers to emit (option (a)). It
// asserts ONLY the security-relevant privileged-mutation domains below. Product
// mutations OUTSIDE that allowlist (e.g. graph.*, document.*, automation.*,
// conversation.*) are considered fully covered by the kernel capability.invoke_*
// audit and are intentionally NOT asserted here. Widening the allowlist is a
// deliberate decision, not an automatic consequence of adding a handler.
//
// For each allowlisted handler the invariant is: the file must EITHER emit a
// security event (one of the emit helpers) OR carry an explicit
// `// audit-exempt: <reason>` comment documenting why a domain-specific audit
// row is not warranted (read-only handler, internal helper, or no fitting event
// type exists in the taxonomy — we never invent event types to satisfy this
// test).
//
// @oxagen/compliance is a pure leaf package (no dependency on @oxagen/database
// or @oxagen/handlers), so handler files are read straight off disk via node:fs
// rather than imported — importing the handlers package would pull in the entire
// database/kernel runtime and invert the dependency graph.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// ESM: no __dirname. Derive this file's directory from import.meta.url, then
// resolve the sibling handlers package source directory.
const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDLERS_SRC = join(__dirname, "../../handlers/src");

// ─────────────────────────────────────────────────────────────────────────────
// Skip-set — infra / glue files in packages/handlers/src that are NOT capability
// handlers and therefore have no audit obligation. Hardcoded (not heuristic) so
// the list is auditable and an accidental new infra file fails loudly until it
// is classified.
// ─────────────────────────────────────────────────────────────────────────────
const INFRA_SKIP = new Set<string>([
  "index.ts", // barrel re-export
  "register.ts", // handler registration glue
  "registry-default.ts", // MCP registry helper (add/remove primitives)
  "logger.ts", // pino logger + maskEmail
  "event-client.ts", // Inngest client wrapper
  "workspace-registry-seed.ts", // default-registry seeding helper
  "graph.telemetry.ts", // ClickHouse graph-telemetry emitter (no capability surface)
  "workspace-agents.ts", // bootstrap helper invoked inside workspace.create
]);

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED-EMIT allowlist — the security-relevant privileged-mutation domains.
// A handler file is in scope iff its basename starts with one of these prefixes.
// Read-only / list / preview handlers that share a prefix
// (e.g. plugin.org.list, plugin.registry.list, billing.subscription.read) are
// still in scope — they satisfy the invariant via an `// audit-exempt:` comment,
// which keeps the decision explicit rather than silently skipping them.
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_EMIT_PREFIXES: readonly string[] = [
  "api.key.", // API key lifecycle (create / revoke / rotate)
  "org.member.", // org membership + role mutations + invite lifecycle
  "org.settings.", // org-profile reads/writes
  "billing.", // billing mutations (checkout, plan/seat/subscription)
  "plugin.org.", // org-level plugin governance (install / uninstall / enable)
  "plugin.workspace.", // workspace-level plugin enable/disable
  "plugin.credential.", // plugin credential set / reauth
  "plugin.registry.", // MCP registry source add / remove
  "plugin.settings.set_auth_alerts", // org auth-alert notification policy
  "privacy.", // GDPR export / erasure requests
  "workspace.create", // workspace creation (privileged bootstrap)
  "workspace.invite", // workspace member invitation
  "workspace.settings.write", // workspace-profile mutation
  "org.create", // org creation (privileged bootstrap)
  "iam-provision", // IAM bootstrap helper (roles / principals / grants)
  "prompt.settings.write", // system-prompt customization mutation
] as const;

// Matches any of the four emit helpers exported from @oxagen/database/security
// (sync + async + the older record* aliases). Word-boundaried so a substring in
// a comment like "emit a security event" does not false-positive.
const EMIT_RE =
  /\b(emitSecurityEvent|emitSecurityEventAsync|recordSecurityEvent|recordSecurityEventAsync)\b/;

// Matches `// audit-exempt: <reason>` — the reason must be non-empty.
const AUDIT_EXEMPT_RE = /\/\/\s*audit-exempt:\s*\S+/;

function isAllowlisted(basename: string): boolean {
  const name = basename.replace(/\.ts$/, "");
  return REQUIRED_EMIT_PREFIXES.some(
    (prefix) =>
      // Either the file IS the prefix (e.g. "org.create") or it begins
      // with the dotted prefix (e.g. "api.key." → "api.key.revoke").
      name === prefix || name.startsWith(prefix),
  );
}

function listHandlerFiles(): string[] {
  return readdirSync(HANDLERS_SRC)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .filter((f) => !INFRA_SKIP.has(f))
    .sort();
}

describe("SOC2 audit-trail coverage invariant (security-relevant domains)", () => {
  const allFiles = listHandlerFiles();
  const allowlisted = allFiles.filter(isAllowlisted);

  it("discovers handler source files on disk", () => {
    // Sanity: the path resolved and we are actually reading handlers. If this is
    // empty, the relative path is wrong and every assertion below would vacuously
    // pass — so guard against a silently-empty enumeration.
    expect(allFiles.length).toBeGreaterThan(50);
  });

  it("matches a non-trivial set of security-relevant handlers", () => {
    // Guard against the allowlist drifting to zero matches (e.g. a directory
    // rename), which would make the per-file assertion vacuous.
    expect(allowlisted.length).toBeGreaterThanOrEqual(25);
  });

  it.each(allowlisted)(
    "%s emits a security event or is explicitly audit-exempt",
    (file) => {
      const src = readFileSync(join(HANDLERS_SRC, file), "utf8");
      const emits = EMIT_RE.test(src);
      const exempt = AUDIT_EXEMPT_RE.test(src);

      expect(
        emits || exempt,
        `\n${file} is a security-relevant privileged-mutation handler but neither ` +
          `emits a security event nor is marked audit-exempt.\n\n` +
          `Fix one of:\n` +
          `  • If it is a privileged state change with SOC2 relevance, add an\n` +
          `    emitSecurityEvent({ eventType: "<existing taxonomy type>", ... })\n` +
          `    call using a type from packages/compliance/src/security-event-types.ts\n` +
          `    (do NOT invent a new event type here).\n` +
          `  • If it genuinely should not produce a domain-specific audit row\n` +
          `    (read-only, internal helper, or no fitting event type exists), add a\n` +
          `    top-of-file comment:  // audit-exempt: <concrete reason>\n`,
      ).toBe(true);
    },
  );
});
