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
// This test does NOT force every mutating handler to emit. It asserts ONLY the
// security-relevant privileged-mutation domains below. Product mutations OUTSIDE
// that allowlist (e.g. graph.*, document.*, automation.*, conversation.*) are
// considered fully covered by the kernel capability.invoke_* audit and are
// intentionally NOT asserted here. Widening the allowlist is a deliberate
// decision, not an automatic consequence of adding a handler.
//
// NOT COVERED, and credential-bearing — read this before citing the allowlist as
// complete. `secret.*` (reveal / export / value.set / key.delete) and
// `connection.*` / `integration.*` (third-party data-access grants) are absent
// from REQUIRED_EMIT_PREFIXES and emit no security_events row. The secret
// handlers do audit, but to a SEPARATE store — `environments.secret_access_log`,
// written inside @oxagen/plugins revealSecret — which is not in
// SECURITY_EVENT_TYPES, not queryable from the audit-log UI, and not correlated
// with security_events. Closing that gap needs new taxonomy values plus an
// additive migration, so it is a design decision, not an allowlist edit.
//
// KNOWN GAP — this guard is not reached by the affected-package gate.
// `pnpm gate` runs `turbo ... --filter=...[origin/main]`, which selects a
// package only when it or one of its dependencies changed. @oxagen/compliance
// declares no dependency on @oxagen/handlers (deliberately — see the leaf-package
// note below), so a PR that touches ONLY packages/handlers does not run this
// file. Adding an unaudited billing handler is exactly that shape of PR.
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
// the list is auditable.
//
// This set is a readability aid, NOT a second gate: a file is asserted only if
// it matches REQUIRED_EMIT_PREFIXES below, so a new unclassified file that does
// not match a prefix is silently unasserted whether or not it is listed here.
// Removing a name from this set therefore does not fail the suite unless the
// name also matches a prefix.
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

// Matches a CALL to any of the four emit helpers exported from
// @oxagen/database/security (sync + async + the record* aliases). The trailing
// `\s*\(` is load-bearing: without it a bare `import { emitSecurityEvent }` that
// is never invoked would satisfy the invariant. Longest alternative first so
// `emitSecurityEventAsync(` is not mis-anchored. Word-boundaried at the front so
// prose like "emit a security event" does not false-positive.
//
// Deliberately shallow: it proves a call EXISTS, not that the call is reachable,
// on the success path, or carries a domain-appropriate eventType. A billing
// handler emitting `capability.invoke_allowed` from inside a dead branch would
// satisfy it. Per-handler unit tests are what assert the row's contents.
const EMIT_RE =
  /\b(emitSecurityEventAsync|recordSecurityEventAsync|emitSecurityEvent|recordSecurityEvent)\s*\(/;

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

// Top level only — `readdirSync` is not recursive, so a handler moved into a
// subdirectory (e.g. src/billing/plan.ts) leaves the allowlist silently. Today
// the only subdirectories are lib/, test-utils/ and __tests__/, none of which
// hold capability handlers.
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
