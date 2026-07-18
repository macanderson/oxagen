# ADR-034: Customer-built capability packages (`.cap`)

**Status:** Proposed
**Date:** 2026-07-18
**Relates to:** ADR-009 (unified capability/tool model), ADR-013 (Oxagen Plugins as capability packs), ADR-025 (verb-first snake naming), ADR-007/ADR-011 (sandbox drivers), ADR-002 (Inngest), ADR-004 (env vars)
**Supersedes:** ADR-013 Phase 3 (the unbuilt `plugin.capability_catalog` table and out-of-process partner handler protocol)
**Spec:** `docs/specs/customer-capabilities/spec.md`

## Context

Every Oxagen capability is a typed contract (`registerCapability()` in
`packages/oxagen/src/contracts/`) dispatched through one kernel
(`packages/oxagen/src/kernel.ts` `invoke()`) that enforces surface allowlists,
Zod input/output validation, IAM, billing admission, entitlements, audit, and
tracing. This model is strict and correct — but it is **compile-time only**:

1. Contracts and handlers register via import side effects into a
   `globalThis`-anchored in-process map. A customer cannot add one without a
   platform deploy.
2. Surface exposure is hand-written per capability: a Hono route file plus two
   hand-listed lines in `apps/api/src/app.ts` (276 route files / 571 `.route()`
   calls), an xmcp tool file per capability (330 files), optional app server
   action + `capability-ui-map.json` entry, and hand-wired CLI commands.
   Parity is enforced after the fact by gates (`check:manifest`,
   `check:ui-parity`, route/tool parity tests) rather than produced by
   construction.
3. The agent surface already proves the alternative: `materializeTools`
   (`packages/agent/src/runtime/materialize-tools.ts`) binds **every**
   agent-surfaced capability generically by iterating the registry — zero
   per-capability files.

ADR-013 introduced installable "capability packs" and shipped Phase 1 (manifest
schema, kernel entitlement gate keyed on `installed_plugins`, four first-party
media/document packs). Its Phase 3 — the DB capability catalog and the
out-of-process execution protocol that would let a **non-first-party** author
ship a capability — was never built. Customers therefore cannot build, package,
version, or install their own capabilities today.

## Decision

We will let customers author capabilities **as code in their own Git
repositories**, package them as **`.cap` files** (a zip archive with a required
layout and manifest), and install them per workspace. The platform — not the
author — surfaces each installed capability on REST, MCP, agent tools, the app,
and the CLI, driven entirely by the contract and manifest. Concretely:

1. **`.cap` package format.** A zip with `manifest.json` (generated, machine
   artifact), portable JSON Schema contracts, bundled ESM handlers, optional UI
   component bundles, per-capability docs, and an integrity block. The manifest
   extends the shipped `oxagenPluginManifestSchema` and follows the
   `kind`/`formatVersion` literal pattern of the portable sandbox-template
   manifest v1. Source of truth is the author's TypeScript
   (`defineCapability()` in `@oxagen/cap-sdk`); `oxagen cap build` compiles it.

2. **Dynamic registry overlay.** New tables `capability_packages`,
   `capability_package_versions` (immutable, checksummed, semver — the
   `agent.skill_versions` pattern), and `capability_installs` (workspace-scoped
   active-version pointer). The kernel gains an injected workspace-scoped
   resolver (same pattern as `setCapabilityEntitlementGate`) so `invoke()`
   resolves static contracts first, then installed ones. Kernel-side validation
   is unchanged: portable JSON Schemas are materialized into Zod validators at
   install/load time, so `cap.input.safeParse`/`cap.output.safeParse` run
   exactly as they do for first-party contracts.

3. **Out-of-process execution.** Customer handler code never runs in the
   platform process. A **capability runner** executes bundles inside the
   existing sandbox substrate (`packages/sandbox` drivers, policy chokepoint,
   durable warm sessions, digest-pinned runner image). Handlers receive a
   brokered **host API** (`ctx.invoke`, `ctx.secrets`, `ctx.ai`, `ctx.storage`,
   `ctx.log`) over an authenticated callback carrying a per-invocation scoped
   token; every effect re-enters `kernel.invoke()` under the invocation's
   principal and the manifest's declared permissions. Long-running capabilities
   use `mode: "async"` and ride Inngest (the `video.generate` →
   `agent/video.render` pattern, generalized into a `capability_runs` job
   envelope).

4. **Generic surface binders, first-party first.** REST routes, MCP tools, app
   pages, and CLI commands are materialized from the registry the way
   `materializeTools` already does for agent tools: a registry-driven route
   table replaces the hand-listed `app.ts` mounts, the MCP server moves from
   build-time file discovery to a per-connection dynamic tool list
   (static ∪ workspace installs), the app gains a schema-driven generic
   capability runner page feeding the existing render-directive pipeline, and
   the CLI materializes workspace commands from a synced capability index.
   We dogfood by binding `generate_svg`, `generate_image`, and
   `generate_video` through the binders and deleting their hand-written
   wrappers before any customer package ships. Surface parity becomes a
   property of construction; the parity gates remain as regression alarms.

5. **Naming.** Installed capability names are `{namespace}_{action}` where the
   org-registered `namespace` must not collide with the ADR-025 action
   vocabulary and `action` must itself pass ADR-025 (`verb_noun[_qualifier]`,
   closed verb set). Platform names always start with an action verb, so
   prefix collisions are impossible by construction. `role_grants.capability_id`
   is a text column, so grants, IAM defaults, audit, and metering work with no
   schema migration.

## Consequences

- Customers design the contract and write the handler; Oxagen does everything
  else. Surfacing a capability on API + MCP + app + CLI becomes a
  business-process decision (flags in the manifest), not an engineering task.
- The kernel remains the single enforcement point. Nothing in this design adds
  a second dispatch path; it adds a second *source of declarations*.
- First-party capability authoring cost drops from ~7–10 files to
  contract + handler + tests + doc; the three mechanical wrapper classes
  (REST route file, `app.ts` lines, MCP tool file) are deleted.
- New standing infrastructure: runner images and warm session pools (compute
  cost, metered to the owning org), a package validation pipeline, and an app
  "Package Studio" build flow (Git-connected builds run in the sandbox).
- Untrusted code and untrusted UI enter the platform. The blast radius is
  bounded by the sandbox policy chokepoint, the brokered host API (no ambient
  DB/storage handles, fail-closed IAM on every re-entry), manifest-declared
  permissions, egress allow-lists, iframe-sandboxed custom UI, and package
  checksums. These boundaries are the bulk of the spec.
- ADR-013's manifest and entitlement gate are kept and extended; its Phase 3
  design is retired in favor of this ADR.

## Alternatives considered

- **Config-driven capabilities in the database** (no-code builder): rejected —
  the user requirement is explicitly code in SCM; DB-only configuration cannot
  express real handler logic, cannot be reviewed/versioned in Git, and drifts.
- **In-process execution of customer bundles** (`vm`/worker threads): rejected —
  Node has no safe in-process isolation; a hostile bundle could reach ambient
  tenant scope, env, and connection pools.
- **Per-workspace compiled CLI binaries**: rejected — distribution, signing,
  and update churn for marginal benefit; the CLI instead materializes commands
  dynamically from the synced workspace capability index (see spec §10.5).
- **MCP-only exposure of customer capabilities** (skip REST/app/CLI): rejected —
  parity is the product's law and the customer requirement ("effort concerning
  business processes, not technology").
