# Customer-Built Capability Packages (`.cap`)

**Status:** Proposed (spec for review)
**Date:** 2026-07-18
**ADR:** `docs/adr/ADR-034-customer-capability-packages.md`
**Plan:** `docs/specs/customer-capabilities/plan.md`
**Supersedes:** ADR-013 Phase 3 (`plugin.capability_catalog` + out-of-process partner handler protocol — never built)
**Builds on:** ADR-009, ADR-013 Phases 1–2, ADR-025, ADR-007/ADR-011, ADR-002, `docs/specs/workspace-scoped-marketplace/SPEC.md`, `docs/specs/sandbox-templates-portable/`

---

## 1. Scope

Let customers **design, build, package, version, install, and ship their own
capabilities** with the same strictness as first-party ones — typed contract,
handler, full surface parity — while Oxagen does all of the surfacing:

- Authored **as code, in the customer's own Git repository** (not database
  configuration). Versioned by their SCM; releases are tags.
- Packaged as a **`.cap` file** — a zip archive with a required structure and
  manifest — that is portable, installable, and immutable per version.
- Installed **per workspace**, gated by the existing kernel entitlement seam,
  IAM role grants, billing, and audit.
- Surfaced automatically — REST endpoint, MCP tool, agent tool, app UI, CLI
  command — **from configuration, with zero surface code written by the
  customer**. The customer decides *where* it surfaces (manifest flags);
  Oxagen's generic binders do *how*.

**The running example** used throughout: Acme Corp wants AI agents (running on
a non-Oxagen agent platform) to automate **returns & refunds processing**. Acme
writes one contract + one handler, declares
`surfaces: ["api", "mcp", "agent", "app", "cli"]`, and gets: a REST endpoint
their systems call, an MCP tool any external agent runner can invoke against
their workspace MCP endpoint, an in-app form + result card, and a CLI command —
without writing a route, a tool file, a React page, or a commander block.

### Non-goals (v1)

- A public marketplace with community publishing and revenue share
  (`workspace-scoped-marketplace` and `skills-marketplace` cover the listing
  substrate; publishing customer packages *between* orgs is Phase 4+).
- Non-JavaScript handler runtimes (the runner image is Node 20+; WASM and
  container-per-package runtimes are a later runner profile).
- Custom UI components authored by publishers — stubbed in §10.4 and deferred
  to a dedicated spec; v1 ships the auto-form runner page + curated
  components only.
- Replacing connectors/MCP-server plugins or skills. Those remain their own
  plugin types; a `.cap` is specifically **executable capability code**.
- Mobile surface bindings (ADR-026 parity applies once the app binder exists).

---

## 2. Why: the current cost of a capability

The platform's dispatch core is already dynamic and config-driven:

- **One contract** carries everything: name, domain, description, mode,
  surfaces, IAM defaults, sensitivity, agent metadata, render hints, chaining
  tags, Zod input/output (`CapabilityDeclaration`,
  `packages/oxagen/src/types.ts:145`).
- **One dispatch chokepoint**: `invoke(name, input, ctx, { surface })`
  (`packages/oxagen/src/kernel.ts:504`) — surface allowlist → input parse →
  IAM (fail-closed) → billing admission → entitlement gate → handler →
  output parse → security/trace events.
- **One proof that generic binding works**: the agent surface has **zero
  per-capability files** — `materializeTools`
  (`packages/agent/src/runtime/materialize-tools.ts:338`) iterates
  `listCapabilities()`, filters by surface/entitlement, and builds every tool
  from `cap.name`/`cap.description`/`cap.input`.

Everything *around* that core is hand-written per capability:

| Surface | Per-capability artifact today | Count |
|---|---|---|
| REST | `apps/api/src/routes/v1/<name>.ts` (parse → `invoke()`) **plus** an import line and a `.route()` line hand-listed in `apps/api/src/app.ts` | 276 route files, 571 `.route()` calls |
| MCP | `apps/mcp/src/tools/<name>.ts` — schema/name/description all re-exported *from the contract*, plus per-field `.describe()` overlays | 330 files |
| App | Optional server action + `capability-ui-map.json` entry + form component (`generate_video` has one; svg/image ride the chat render registry) | per-`app`-layer capability |
| CLI | Hand-wired commander blocks per domain (`apps/cli/src/commands/*.ts`), calling REST | per domain |
| Agent | — (registry-driven) | 0 |

Adding one capability costs **~7–10 files**, of which the REST wrapper, the
`app.ts` lines, and the MCP tool file are purely mechanical projections of the
contract. Parity is maintained by after-the-fact gates
(`check:manifest`, `check:ui-parity`, `route-contract-parity.test.ts`,
`tool-registry.test.ts`) — excellent regression alarms, but they verify
hand-work instead of eliminating it.

For customers the situation is binary: **they cannot add a capability at all.**
Contracts register at compile time via import side effects
(`packages/oxagen/src/registry.ts:48`); handlers bind in
`packages/handlers/src/register.ts`; there is no dynamic path. ADR-013 shipped
the install/entitlement half (manifest, `installed_plugins`, kernel gate,
`capability_not_installed`) and explicitly deferred the other half — a DB
catalog and out-of-process execution — which was never built.

This spec closes that gap, and pays down the first-party boilerplate on the
way (the binders that make customer capabilities possible are the same ones
that delete our own wrapper files).

---

## 3. Design overview

```
 Customer Git repo                      Oxagen platform
┌───────────────────────┐
│ capabilities/          │   oxagen cap build
│   process_refund.ts    │  ──────────────────►  acme-returns-1.2.0.cap
│   process_refund.      │   (compile, validate,      │
│     handler.ts         │    bundle, checksum)       │ upload / Git-connected
│   process_refund.md    │                            ▼ build (Package Studio)
│ cap.config.ts          │                 ┌─────────────────────────┐
│ (CI: cap build+publish)│                 │ Validation pipeline      │
└───────────────────────┘                 │ manifest ✓ schemas ✓     │
                                          │ bundle ✓ docs ✓ limits ✓ │
                                          └───────────┬─────────────┘
                                                      ▼
                             capability_packages / _versions (immutable blob+manifest)
                                                      │ install (workspace)
                                                      ▼
                                          capability_installs (active version, enabled)
                                                      │
              ┌───────────────────────────────────────┼──────────────────────────┐
              ▼                                       ▼                          ▼
   Dynamic registry overlay              Surface binders (generic)      Capability runner
   static contracts ∪ workspace          API route table · MCP dynamic  sandbox drivers,
   installs → CapabilityDeclaration      tool list · agent tools · app  warm sessions,
   (Zod materialized from JSON Schema)   runner page · CLI sync         digest-pinned image
              │                                       │                          ▲
              └────────────► kernel.invoke() ─────────┴──── handler dispatch ────┘
                    (surfaces, IAM, billing,                 (host API callback:
                     entitlement, I/O validation,             ctx.invoke/secrets/ai/
                     audit, tracing — unchanged)              storage — re-enters kernel)
```

Five pillars, each specified below:

1. **The `.cap` package format** (§5) — what a package is.
2. **Authoring experience** (§6) and **contracts across the trust boundary**
   (§7) — how customers write one.
3. **Dynamic registry overlay** (§8) — how the kernel learns about installs.
4. **The capability runner** (§9) — where customer code executes and what it
   is allowed to touch.
5. **The surface parity engine** (§10) — how every surface materializes
   bindings from configuration; **install & lifecycle** (§11) and
   **security** (§12) wrap around all of it.

Design invariant, stated once: **the kernel remains the single dispatch and
enforcement path.** This design adds a second *source of capability
declarations* and a second *place handlers execute* — never a second way to
call one.

---

## 4. Naming

Runtime-canonical names of installed capabilities are

```
{namespace}_{action}
e.g.  acme_returns_process_refund
      namespace = acme_returns   action = process_refund
```

- `action` must independently satisfy ADR-025: `verb_noun[_qualifier]`,
  verb from the closed action vocabulary (`tools/scripts/check-naming.mjs`),
  snake_case.
- `namespace` is registered once per org (globally unique, see §8.1) and is
  rejected if its first token is in the ADR-025 action vocabulary. Since every
  platform capability name **starts** with an action verb and every installed
  name **starts** with a namespace that *cannot* be an action verb, static and
  installed names can never collide — by construction, not by lookup.
- The full name is what flows everywhere a capability name flows today:
  `role_grants.capability_id` (a text column, not an FK —
  `packages/database/src/schema/iam.ts:118` — so **no migration is needed**
  for grants), ClickHouse `tool_invocations.capability_name`, audit rows,
  MCP tool names, model-facing tool names (via the existing
  `toModelToolName` aliasing).
- Display names are free-form (`displayName: "Process refund"`); docs and UI
  show display names with the canonical name as the stable identifier,
  mirroring how `docs/capabilities/` shows dotted legacy labels beside
  ADR-025 names during the naming migration.

The shared validator moves to `packages/oxagen/src/naming.ts` so
`check-naming.mjs` (in-repo contracts) and the package validation pipeline
(installed contracts) enforce identical rules.

---

## 5. The `.cap` package format

A `.cap` file is a **zip archive** (deterministic ordering, no compression
tricks) with this required layout:

```
acme-returns-1.2.0.cap
├── manifest.json                     # REQUIRED — machine artifact, generated by `cap build`
├── contracts/
│   ├── process_refund.input.json     # REQUIRED per capability — JSON Schema (portable subset)
│   ├── process_refund.output.json    # REQUIRED per capability
│   └── lookup_return_status.{input,output}.json
├── handlers/
│   └── bundle.mjs                    # REQUIRED — single bundled ESM module, all handlers
├── ui/                               # RESERVED — custom components are NOT processed in v1
│   └── …                             # (validation warns and ignores; §10.4 stub)
├── docs/
│   ├── process_refund.md             # REQUIRED per capability — the `docs` layer, rendered in-app
│   └── lookup_return_status.md
├── assets/                           # OPTIONAL — icons, screenshots (icon.svg reserved)
├── CHANGELOG.md                      # REQUIRED — human changelog
└── integrity.json                    # REQUIRED — sha256 per file + package digest (§12.5)
```

### 5.1 The manifest

`manifest.json` is **generated, never hand-edited** — the authored source of
truth is TypeScript (§6). It extends the shipped plugin manifest
(`oxagenPluginManifestSchema`, `packages/oxagen/src/plugins/manifest.ts:32`)
and follows the `kind` + literal-version convention of the portable
sandbox-template manifest v1
(`packages/oxagen/src/contracts/sandbox-template-manifest.ts:151`):

```jsonc
{
  "kind": "oxagen.capability-package",
  "formatVersion": 1,
  "id": "acme/returns",                       // publisher-scoped package id
  "namespace": "acme_returns",                // §4 — org-registered, unique
  "version": "1.2.0",                         // semver, immutable once published
  "displayName": "Acme Returns & Refunds",
  "description": "Automates refunds and returns processing against Acme's OMS.",
  "publisher": { "org": "acme", "contact": "platform@acme.com" },
  "runtime": { "kind": "node", "range": ">=20" },
  "sdk": { "capSdk": "^1.0.0" },              // host API contract version (§9.3)

  "capabilities": [
    {
      "action": "process_refund",             // runtime name: acme_returns_process_refund
      "displayName": "Process refund",
      "description": "Validate a return, compute the refund, execute it in the OMS, and notify the customer.",
      "mode": "sync",                         // "sync" | "async"  (§9.5)
      "surfaces": ["api", "mcp", "agent", "app", "cli"],
      "contract": {
        "input": "contracts/process_refund.input.json",
        "output": "contracts/process_refund.output.json"
      },
      "handler": "handlers/bundle.mjs#processRefund",
      "scoped": true,
      "sensitivity": "high",
      "defaultEffect": "deny",
      "defaultRoles": {
        "org": { "Owner": "allow", "Admin": "allow" },
        "workspace": { "Owner": "allow", "Member": "require_approval" }
      },
      "agent": { "requiresApproval": true, "riskLevel": "high", "category": "commerce" },
      "audit": { "targetKind": "acme.return", "targetIdField": "returnId" },
      "render": { "componentId": "capability-result", "titleField": "refundId" },
      "produces": ["acme.refundId"],
      "consumes": ["acme.returnId"],

      "permissions": {                        // §9.4 — everything else is denied
        "capabilities": ["search_graph_nodes", "send_notification"],
        "secrets": ["ACME_OMS_TOKEN"],        // vault key NAMES, never values
        "network": ["oms.acme.com"],
        "ai": { "tiers": ["fast", "balanced"] }
      },
      "limits": { "timeoutMs": 30000, "memoryMb": 512 }
    }
  ],

  "sandbox": { "image": null }                // optional digest-pinned custom runner image (§9.2)
}
```

Field-for-field, a manifest capability entry is the serializable projection of
`CapabilityDeclaration` (`packages/oxagen/src/types.ts:145`) — same `mode`,
`surfaces`, `layers`-implied artifacts, `agent`, `sensitivity`,
`defaultEffect`, `defaultRoles`, `audit`, `render`, `produces`/`consumes` —
plus the three package-only blocks: `handler` (entry point), `permissions`,
and `limits`. This is deliberate: **the manifest is the contract**, exactly as
the in-repo declaration is, so the registry overlay (§8) can materialize a
real `CapabilityDeclaration` from it and everything downstream (kernel, IAM
seeding, `capability.registry.*`, materializeTools, binders) treats installed
and first-party capabilities uniformly.

### 5.2 What is *not* in a package

- **No secret values** — only vault key names (`permissions.secrets`),
  matching the sandbox-template manifest rule ("names, never values").
- **No platform code** — bundles must not import `@oxagen/*` packages;
  `@oxagen/cap-sdk` is type-only at runtime (the host API arrives as the
  handler's `ctx` argument). `cap build` fails the build otherwise.
- **No workspace/org identifiers** — packages are portable across workspaces
  and orgs; identity is injected at invocation time via `ctx`.

---

## 6. Authoring experience

### 6.1 Repo scaffold and SDK

```bash
oxagen cap init acme/returns          # scaffolds a Git-ready repo
```

```
returns/
├── cap.config.ts            # package-level metadata (id, namespace, publisher, runtime)
├── capabilities/
│   ├── process_refund.ts    # contract — defineCapability({...})
│   ├── process_refund.handler.ts
│   ├── process_refund.test.ts
│   └── process_refund.md    # doc, verbatim into the package docs/ dir
├── ui/                      # reserved — custom components (future spec, §10.4 stub)
├── package.json             # devDeps: @oxagen/cap-sdk, @oxagen/cap-cli
└── .github/workflows/cap.yml  # scaffolded CI: build → test → publish on tag
```

The contract file mirrors first-party authoring one-for-one so the mental
model transfers (and so our own contracts can migrate later):

```ts
// capabilities/process_refund.ts
import { z } from "zod";
import { defineCapability } from "@oxagen/cap-sdk";

export const processRefund = defineCapability({
  action: "process_refund",
  displayName: "Process refund",
  description: "Validate a return, compute the refund, execute it, notify the customer.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "app", "cli"],
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "require_approval" },
  },
  agent: { requiresApproval: true, riskLevel: "high", category: "commerce" },
  audit: { targetKind: "acme.return", targetIdField: "returnId" },
  input: z.object({
    returnId: z.string().min(1),
    reason: z.enum(["damaged", "wrong_item", "no_longer_needed", "other"]),
    refundShipping: z.boolean().default(false),
  }),
  output: z.object({
    refundId: z.string(),
    amountCents: z.number().int().nonnegative(),
    currency: z.string().length(3),
    status: z.enum(["executed", "pending_review"]),
  }),
  permissions: {
    capabilities: ["search_graph_nodes", "send_notification"],
    secrets: ["ACME_OMS_TOKEN"],
    network: ["oms.acme.com"],
  },
});
```

```ts
// capabilities/process_refund.handler.ts
import { defineHandler } from "@oxagen/cap-sdk";
import { processRefund } from "./process_refund";

export const processRefundHandler = defineHandler(processRefund, async (input, ctx) => {
  const omsToken = await ctx.secrets.get("ACME_OMS_TOKEN");        // vault, declared key only
  const ret = await fetch(`https://oms.acme.com/returns/${input.returnId}`, {
    headers: { authorization: `Bearer ${omsToken}` },
  }).then((r) => r.json());                                        // egress allow-listed

  const amountCents = computeRefund(ret, input.refundShipping);
  const refund = await executeRefund(omsToken, ret, amountCents);

  await ctx.invoke("send_notification", {                          // kernel re-entry, permissioned
    userId: ret.customerId,
    title: `Refund issued: ${(amountCents / 100).toFixed(2)} ${ret.currency}`,
  });

  return { refundId: refund.id, amountCents, currency: ret.currency, status: "executed" };
});
```

Handlers are typed against the contract exactly like
`CapabilityHandler<typeof svgGenerate>` is today
(`packages/oxagen/src/types.ts:250`) — `(input, ctx) => Promise<output>` with
inference from the Zod schemas. The **difference** from first-party handlers
is the `ctx`: first-party handlers import platform packages directly and rely
on ambient tenant scope; customer handlers get **only** the brokered host API
(§9.3). There is no ambient anything.

### 6.2 The toolchain

| Command | What it does |
|---|---|
| `oxagen cap init` | Scaffold repo (above). |
| `oxagen cap dev` | Local dev loop: runs the handler in the local runner image (docker sandbox driver), serves a local surface emulator (REST + MCP + auto-form UI) against a local host broker with fixture and live-proxy modes (§6.3). |
| `oxagen cap test` | Runs the author's tests inside the runner image + the platform conformance suite: contract portability (§7), manifest validity, handler I/O round-trips against the compiled schemas, permission-violation probes (undeclared capability/secret/host must fail). |
| `oxagen cap build` | Compile contracts (Zod → JSON Schema, §7), bundle handlers/UI (esbuild, externals forbidden), emit manifest + integrity, produce `dist/<id>-<version>.cap`. |
| `oxagen cap publish` | Upload the `.cap` to the org's package registry (§8.1). `--workspace` also installs. CI runs this on tag push. |
| `oxagen cap doctor` | Static lint of an existing repo/package: naming, schema subset, permission hygiene, doc presence. |

**Git is the source of truth.** A published version records
`{ gitRemote?, commitSha?, tag? }` when built via CI or Package Studio (§11.2),
so every installed version is traceable to a commit. The platform never edits
customer capability code; the DB stores install state and immutable artifacts
only.

### 6.3 Local dev, debugging, and errors

The dev loop is make-or-break for adoption, so it is **beta-blocking**
(plan Phase 2), not post-GA polish:

- **`oxagen cap dev`** runs the bundle in the local runner image (docker
  driver) behind a local surface emulator — REST on localhost, an MCP
  endpoint any client can connect to, the auto-form page — with the host
  broker in one of two modes:
  - **Fixture mode** (default): `ctx.invoke` / `ctx.secrets` / `ctx.ai`
    resolve from declarative fixtures in `fixtures/` (hand-written or
    recorded responses keyed by capability/secret name), so the loop is
    hermetic, fast, and CI-safe — `cap test` runs against the same fixtures.
  - **Live mode** (`--workspace <dev-workspace>`): the broker proxies to a
    real workspace under the author's credentials with normal IAM, billing,
    and audit — the integration-test path before publishing.
- **Error taxonomy** (SDK): `throw new CapUserError(message, details?)` is a
  *caller-facing* failure — the message crosses the boundary verbatim
  (schema-validated, size-clamped) on every surface. Any other throw is an
  *internal* error: callers get a generic failure plus `runId`; the full
  stack and the `ctx.log` stream appear only in the run detail view.
  Timeouts, OOM kills, and permission denials surface as distinct typed
  runner errors, never generic 500s — an author can tell "my bug" from "my
  limits" from "my manifest" at a glance.
- **Publisher observability:** every invocation is a `capability_runs` row
  (§9.5) with retained logs; the package detail page rolls up per-version
  error rate, p50/p95 latency, and top error classes across the org's
  installs. Cross-org publisher telemetry is explicitly a Phase 4
  (marketplace) question — in v1 the publisher and installer are the same
  org and see the same runs.

---

## 7. Typed contracts across the trust boundary

The strict rule stands: every capability has a typed contract validated by the
kernel on both edges (`cap.input.safeParse` at `kernel.ts:597`,
`cap.output.safeParse` at `kernel.ts:946`). Customer packages must not weaken
this, and the kernel must not execute customer code to validate (a Zod schema
is executable JavaScript; shipping the author's compiled Zod into the platform
process would be arbitrary code execution).

Resolution — **portable schemas, platform-materialized validators**:

1. **Authors write Zod** (v3, the platform's pinned major) in
   `defineCapability`. Full Zod is available to *their handler* at runtime for
   assertions/refinements inside the sandbox.
2. **`cap build` compiles `input`/`output` to JSON Schema** (draft 2020-12)
   via the same `zod-to-json-schema` pipeline the repo already uses
   (`apps/schemas/scripts/generate.ts`,
   `tools/scripts/gen-capability-schemas.ts`), and **fails the build** on any
   construct that does not compile faithfully: `transform`, `preprocess`,
   `refine`/`superRefine`, `lazy`/recursive types, `custom`, functions,
   promises, non-serializable defaults. The allowed subset (objects, arrays,
   records, primitives, enums/literals, unions/discriminated unions,
   optional/nullable/default, string formats, numeric bounds, min/max) covers
   every shape the 349 in-repo contracts use in their I/O — this was the
   design constraint on the subset.
3. **At install time the platform materializes Zod validators from the JSON
   Schemas** (deterministic data → schema conversion; schemas are data, never
   evaluated). The materialized `CapabilityDeclaration` is what the registry
   overlay serves — so the kernel, `materializeTools` (which feeds
   `cap.input` to the AI SDK), the MCP tool list, and the app form generator
   all consume installed contracts through the **same fields** they already
   read on first-party ones. No conditional code paths downstream.
4. **Checksummed compatibility:** the compiled schema is hashed into
   `integrity.json`; the version's schema hash participates in upgrade
   compatibility checks (§11.4).

Per-field descriptions (`.describe()`) survive compilation and become the MCP
tool field descriptions and auto-form labels/help — this replaces the
hand-written `.describe()` overlay files in `apps/mcp/src/tools/`.

---

## 8. Dynamic registry overlay

### 8.1 Data model (three new tables, `plugin` schema)

Following the `agent.skill_versions` immutability pattern
(`packages/database/src/schema/agent.ts:203`) rather than widening
`installed_plugins` (which has no version concept and is a denormalized
config row):

```
plugin.capability_packages          -- publisher registry (org-scoped)
  id, public_id, org_id, package_id ("acme/returns"), namespace (UNIQUE globally),
  display_name, source_repo, created_by, timestamps, soft-delete

plugin.capability_package_versions  -- immutable artifacts
  id, public_id, package_id → capability_packages,
  version (semver; UNIQUE per package), manifest jsonb (snapshot),
  storage_key (private blob: the .cap bytes), package_digest (sha256),
  schema_digest, git_remote, git_commit, git_tag,
  status ('validated' | 'revoked'), is_latest, created_by, created_at
  -- rows are never mutated after validation; revocation is a status flip

plugin.capability_installs          -- per-workspace activation
  id, public_id, org_id, workspace_id, package_id,
  active_version_id → capability_package_versions,
  enabled (default false), installed_from ('upload' | 'git' | 'studio'),
  installed_by, timestamps, soft-delete
  UNIQUE (workspace_id, package_id)
```

The `.cap` blob goes to private storage via the existing `StorageAdapter`
(`packages/storage/src/types.ts:75`, `access: "private"`), with a new asset
kind `capability_package` and a 50 MiB limit added to
`packages/storage/src/assets.ts` (current max is `document` 25 MiB; UI bundles
justify the headroom).

### 8.2 Kernel resolution

The kernel today resolves declarations from the static registry
(`getCapability`, `registry.ts:80`) and handlers from the handler map
(`resolveHandler`, `kernel.ts:466`). Both gain an **injected workspace-scoped
fallback**, using the established kernel-injection pattern
(`setKernelIAMRuntime`, `setCapabilityEntitlementGate` at `kernel.ts:83`):

```
setDynamicCapabilityResolver(async (name, { orgId, workspaceId }) => {
  // 1. static registry hit? → not called (static always wins)
  // 2. cache lookup: workspace → { name → MaterializedCapability }
  //    (TTL 30s + event invalidation on install/enable/version-activate,
  //     mirroring entitlement-service.ts caching)
  // 3. MaterializedCapability = { declaration, dispatch }
  //    declaration: CapabilityDeclaration w/ materialized Zod (§7)
  //    dispatch:    the runner client (§9), closed over package/version refs
})
```

Resolution order in `_invokeCore`: static → dynamic → `unknown_capability`.
Namespace rules (§4) guarantee the two sets are disjoint, so order is a
formality, not a security control. Everything after resolution — surface
allowlist, input parse, IAM, billing, entitlement, output parse, audit,
tracing — runs **unchanged** on the materialized declaration. The entitlement
service (`packages/plugins/src/entitlements/entitlement-service.ts`) extends
its union to include `capability_installs` (enabled, non-deleted, active
version validated), keeping the fail-closed behavior `materialize-tools`
already relies on.

Enumeration (`capabilitiesForSurface`, `kernel.ts:1172`) gains a
workspace-aware variant `capabilitiesForSurfaceInWorkspace(surface, scope)` =
static ∪ installed — this is the single API every surface binder (§10)
consumes, so a new surface binder automatically covers installed capabilities
and vice versa.

`capability.registry.list` / `capability.registry.get` read through the same
overlay, so the governance catalog, docs pages, and `agent.tool.list` show
installed capabilities with an `origin: "package"` marker and their package
provenance — the same "catalog can never drift from the enforced shape"
property those handlers guarantee today.

---

## 9. Execution: the capability runner

Customer code **never executes in a platform process.** ADR-013 Phase 3's
unbuilt "out-of-process handler protocol" lands here, on the shipped sandbox
substrate.

### 9.1 Placement

- **Default: sandboxed runner.** Bundles execute inside the sandbox drivers
  (`packages/sandbox/src/index.ts` — Modal/Vercel Firecracker in
  preview/prod, Docker in dev/self-host), always through the policy
  chokepoint (`getSandbox` → `withPolicy`) that clamps CPU/memory/timeout and
  enforces the network policy.
- **`trusted` profile (first-party only).** The same package format executed
  in-process, handler resolved from the bundle at boot — this is how
  first-party capabilities can migrate onto the package model (§13) with zero
  latency cost. Gated to `source: "oxagen"` packages; never available to
  customer packages regardless of plan.

### 9.2 Runner sessions

A cold Firecracker boot per invocation would put seconds on the p50, so the
runner uses **warm durable sessions** — the mechanism `agent.sandbox.start`
already ships (create/exec/snapshot/stop, idle reaping via the sandbox
reaper):

- Per **(workspace, package version)** warm session pool, size 0→N with idle
  TTL; the session runs the **runner supervisor** from the digest-pinned
  platform runner image (`oxagen/cap-runner@sha256:…`, Node 20, no package
  manager, read-only bundle mount). A package may pin a custom image
  (`manifest.sandbox.image`, digest-required) for native deps; custom images
  are a plan-gated feature and scanned at publish.
- An invocation = one `execInSession` of `cap-call <action>`, which hands the
  JSON envelope `{ invocationId, input, ctxSlice, hostToken }` to the
  supervisor over a local socket and returns `{ output } | { error }` on
  stdout. Driver-portable (uses nothing beyond exec), stateless per call,
  and warm (supervisor holds the loaded bundle).
- `limits.timeoutMs` (manifest, clamped by policy ceiling) bounds the exec;
  the kernel's own invocation timeout is the outer layer, following the
  nested-timeout discipline documented in the video pipeline
  (`packages/inngest-functions/src/functions/agent.video-render.ts:27`).

### 9.3 The host API (the ports of a capability)

The handler's `ctx` is a **brokered client, not platform handles**. Transport:
HTTPS callback to `POST /v1/runner/host` carrying a **per-invocation scoped
token** — short-lived (invocation TTL), bound to
`{ invocationId, orgId, workspaceId, principal, packageVersionId, permissions }`,
signed by the platform, single-audience. The sandbox network policy always
allows the platform API host; everything else requires
`permissions.network`.

| `ctx` member | Backed by | Enforcement |
|---|---|---|
| `ctx.invoke(name, input)` | `kernel.invoke()` re-entry with the invocation's principal, `surface: "runner"` (already in the `CapabilityContext.surface` union, `types.ts:271`) | `permissions.capabilities` allow-list checked by the broker **and** normal kernel IAM/billing/entitlement on the inner call — deny wins at either layer. Re-entry depth capped (default 4); recursion into the calling capability denied. |
| `ctx.secrets.get(name)` | Vault (`secret_keys`/`secret_values`, envelope-encrypted via `@oxagen/crypto`), resolved for the workspace's environment | `permissions.secrets` names only; every read hits `secret_access_log`; values never appear in traces/logs. |
| `ctx.ai.generateObject/text(...)` | `@oxagen/ai` gateway paths (`generateObjectFor` etc.) | `permissions.ai.tiers`; metered through the existing token pipeline under the org (§9.6). |
| `ctx.storage.put/get(...)` + `ctx.assets.persist(...)` | `StorageAdapter` + the `persistGeneratedAsset` seam (what `svg.generate` uses) | Keys server-derived under the workspace prefix; private access; size limits. |
| `ctx.runs` (async mode, §9.5) | `capability_runs` progress updates | Own run only. |
| `ctx.log(level, msg, fields)` | Invocation log stream, retained per run | Size/rate clamped; surfaced in the app's run detail view. |
| `ctx` identity fields | `orgId`, `workspaceId`, `userId`, `principal`, `requestId`, `messageId`, `surface` — the same fields first-party handlers read from `CheckedContext` | Read-only slice; no `planTier` mutation, no raw principal token. |

`sdk.capSdk` in the manifest pins the host-API contract version; the broker
serves every published major so installed packages keep working across
platform deploys.

### 9.4 Permissions model

`permissions` is **default-deny and closed**: an empty block means the handler
can compute on its input and return — no capability calls, no secrets, no
egress, no AI. Install-time consent (§11.3) renders the block as the
human-readable grant screen (the OAuth-scopes moment). Enforcement is
layered: sandbox network policy (egress), broker allow-lists (capabilities,
secrets, AI tiers), kernel IAM (the inner call), vault audit (reads). A
permission the manifest did not declare cannot be granted at install time —
widening requires publishing a new version, which is what makes the grant
screen trustworthy.

### 9.5 Sync and async modes

- **`mode: "sync"`** — request/response through the warm session;
  `limits.timeoutMs ≤ 60s`. This is Acme's refund call.
- **`mode: "async"`** — the platform (not the author) provides the job
  envelope, generalizing the `video.generate` pattern (pending row → Inngest
  event → worker → status flip) that today is hand-built per capability:
  1. `invoke()` validates input, writes a `capability_runs` row
     (`pending`), emits `cap/execute` to Inngest, and returns the uniform
     envelope `{ status: "queued", runId, statusUrl }` immediately.
  2. The Inngest function (`capability.execute`, org-keyed concurrency,
     policy-derived `timeouts.finish`, `retries: 0` default with manifest
     opt-in) re-establishes tenant scope, dispatches to the runner session,
     streams `ctx.runs.progress()` updates onto the row, and lands
     `succeeded` (output validated against the contract) or `failed`.
  3. Reads are uniform: new first-party contract `read_capability_run`
     surfaces run status on **every** surface (REST poll, MCP tool, app run
     view, CLI `--wait`), replacing per-capability polling conventions.
  `capability_runs`: `id, public_id, org_id, workspace_id, capability_name,
  package_version_id?, status (pending|running|succeeded|failed|cancelled),
  input jsonb, output jsonb, error, progress jsonb, timings, cost_usd_micros,
  created_by, message_id?`. First-party async capabilities (video) migrate
  onto this envelope in §13.

### 9.6 Metering and billing

Two-gate discipline, extended (per `packages/billing`):

- **Admission:** unchanged — customer capabilities are subject to the kernel
  billing gate (`assertOrgCanConsume`) unless the manifest sets
  `noBillingGate` *and* the package passes review for it (default: gate on).
- **Usage:** (a) every `ctx.ai` call flows through the existing
  `insertTokenUsage`/credit pipeline — brokered calls are indistinguishable
  from first-party usage; (b) **runner compute** is metered per invocation
  (wall-ms × memory class) with new rate-card entries in
  `packages/billing/src/pricing.ts` following the bias-high rule ("unknown
  cost must never be silently free"); (c) per-invocation platform fee is a
  pricing decision, not an architecture one — the meter hook exists either
  way. Cost lands on `capability_runs.cost_usd_micros` and the standard
  usage breakdowns (`billing.usage.breakdown` already slices by capability
  name; reseller attribution rules already key on capability slices).

---

## 10. The surface parity engine

The binder principle, once: every surface derives its bindings from
`capabilitiesForSurfaceInWorkspace(surface, scope)` and the declaration
fields — the way `materializeTools` already does. **Surface parity stops
being a checklist and becomes a property of construction**; the existing
parity gates stay on as regression alarms and are re-pointed at the binders
(they assert the binder covers the registry, not that N files exist).

### 10.1 REST (`apps/api`)

- **Generic dispatch route** (new):
  `POST /v1/:org/:workspace/cap/:name` → resolve → `invoke(name, body, ctx,
  { surface: "api" })`. This single route serves **every** installed
  capability the moment it is enabled — no mount step, no deploy.
- **One path shape, deliberately.** Installed capabilities are served only
  at the uniform dispatch route — no per-capability "pretty path" aliases.
  (Considered and deferred: aliases would add per-workspace collision
  rules, install-cache invalidation, and OpenAPI complexity for cosmetic
  value; revisit only with customer evidence.) First-party capabilities
  keep their existing paths via a **route table** (name → path/method) that
  replaces the 276 wrapper files and the hand-listed `app.ts` imports with
  one loop at boot — same middleware chain
  (`authMiddleware`/`orgMiddleware`/`workspaceMiddleware`), same
  `capabilityContext(c)`, same error middleware, byte-identical responses
  (§13 gates on this).
- **Async envelope:** `mode: "async"` returns `202 { status: "queued", runId,
  statusUrl }`; `GET .../cap/runs/:runId` is the `read_capability_run`
  binding. (Existing `video.generate` keeps its 200 envelope until its §13
  migration, then 202 under an API version flag.)
- **OpenAPI:** a workspace-scoped generated document
  (`GET /v1/:org/:workspace/openapi.json`) emitted from the same compiled
  JSON Schemas — installed capabilities appear in the customer's own API
  reference automatically. (New capability `export_openapi_document`;
  Phase 3.)

### 10.2 MCP (`apps/mcp`)

This is the surface Acme's non-Oxagen agent runner connects to, so it must be
**per-workspace dynamic** — which file-based discovery cannot do:

- xmcp 0.6.10 enumerates tools by scanning `src/tools/` at build time
  (`apps/mcp/xmcp.config.ts`); the tool set is baked per deploy and identical
  for every caller. The MCP protocol itself supports per-connection
  `tools/list` and `notifications/tools/list_changed`.
- **Change:** the MCP app moves to a **programmatic tool provider**:
  `tools/list` = static registry (surface `mcp`) ∪ the authenticated
  workspace's installs, built from declarations (name, description, compiled
  input schema with field descriptions); `tools/call` = `buildContext` →
  `invoke(name, args, ctx, { surface: "mcp" })` → output-validated result.
  Install/enable/disable emits `list_changed`. The 330 static tool files are
  deleted in §13; their per-field `.describe()` overlays move into the
  contracts (where they already belong and survive schema compilation, §7).
  If xmcp cannot host a dynamic provider cleanly, the server drops to the
  official MCP SDK behind the same auth middleware — the auth model
  (`buildContext`, API-key → org/workspace scope) is unchanged either way.
- Agent-facing annotations derive from declarations: `sensitivity`/`agent`
  metadata → `readOnlyHint`/`destructiveHint`, `requiresApproval` surfaces as
  the existing consent flow.

### 10.3 Agent tools (`packages/agent`)

Cheapest surface: `materializeTools` already filters by entitlement
fail-closed (`materialize-tools.ts:335`). It switches its enumeration to the
workspace-aware overlay API and installed capabilities become agent tools
with approval gating, risk badges, telemetry, and model-name aliasing — zero
new mechanism. `agent.compose` chaining picks up `produces`/`consumes` tags
from manifests for free.

### 10.4 App (`apps/app`)

Three layers, all riding existing render plumbing:

1. **Generic capability runner page** (new):
   `/w/:workspace/capabilities/:name` renders an **auto-form** from the
   compiled input schema (field types/labels/help from the schema + 
   `.describe()` texts; enum → select, boolean → toggle, nested objects →
   groups), submits through a generic server action →
   `invoke(name, input, ctx, { surface: "app" })`, and renders the result
   through the existing precedence — output-embedded `render` directive →
   contract render hint → generic `capability-result` card
   (`resolveRenderDirective` in `packages/oxagen/src/capability-meta.ts`,
   components in `chat-component-registry.tsx`). Async mode renders the run
   view driven by `read_capability_run`. This page also gives **first-party**
   `app`-layer capabilities a default UI, replacing hand-built
   action+form+ui-map wiring for the standard case;
   `capability-ui-map.json` entries are auto-emitted for installed
   capabilities so `check:ui-parity` stays truthful.
2. **Curated components:** the manifest may reference any registered
   componentId (`svg-preview`, `image-preview`, `video-result`,
   `file-attachment`, `capability-result`, …) via `render.componentId` —
   customers whose outputs fit standard shapes get rich rendering with zero
   UI code.
3. **Custom components — STUB; deferred to a dedicated spec.** Custom UI
   exists for user-experience reasons only: some customer capabilities want
   a **human in the loop**, and a schema form is the wrong instrument for
   the moment of judgment — an airline's `assign_seat` capability wants a
   seating-chart picker, not fourteen text inputs. That need is real, it is
   **app-surface-only** (REST/MCP/agent/CLI parity is unaffected by its
   absence), and it is explicitly **not v1**. What v1 fixes now so the lane
   exists later: the `ui/` package directory and the manifest `ui` block
   are **reserved** — validation warns and ignores them, and rendering
   falls back to layers 1–2 (auto-form + curated components), so a package
   shipping UI early degrades gracefully instead of breaking. The future
   spec (`docs/specs/customer-capabilities-ui/`) owns the hard parts —
   embedding isolation (the platform's stored-SVG XSS discipline is the
   floor, not the ceiling), a typed props/actions bridge, publisher trust
   tiers — and must clear a dedicated security review before any customer
   component renders.

Discovery (all layers): installed capabilities appear in the workspace
capability catalog, the sidebar's Installed section, and the command menu
(indexed by `command.menu.search` alongside first-party rows).

### 10.5 CLI (`apps/cli`) — and how "a CLI custom to a workspace" works

The requirement: Acme's operators get a refund command that exists **only**
in workspaces where the package is installed. Three ways to get there:

| Option | How | Verdict |
|---|---|---|
| **A. Dynamic materialization in the standard CLI** | CLI syncs the workspace capability index; commands are generated at parse time from declarations | **Recommended — v1** |
| B. npm-distributed CLI plugin packages (oclif-style) | `.cap` also emits an npm plugin; users install per machine | Deferred: supply-chain surface, per-machine drift, duplicate artifact; revisit for offline-heavy fleets |
| C. Per-workspace compiled binaries | CI builds a branded binary per workspace | Rejected: distribution/signing/update churn; no capability the dynamic approach lacks |

**Option A mechanics.** The CLI already resolves org/workspace from config
and calls REST (`apps/cli/src/lib/api.ts`); it gains:

- `oxagen sync` — fetch the workspace capability index (name, display, http
  path, cli hints, compiled input schema, mode) → cache at
  `.oxagen/capabilities.json` (TTL + `--refresh`; also refreshed on auth and
  workspace switch). Everything below works offline-after-sync; invocation
  requires network anyway.
- **One form, deliberately:** `oxagen cap run <name> [--json | flags]` —
  flags derived from the schema (kebab-cased fields, enums validated,
  booleans as toggles, nested via dotted flags), output pretty-printed or
  `--json`; async mode prints the runId and polls `read_capability_run`
  unless `--no-wait`. Acme's command is:
  `oxagen cap run acme_returns_process_refund --return-id R-1042 --reason damaged`.
  Manifest-declared first-class command groups (`oxagen returns refund …`)
  are **considered and deferred** for the same reason as HTTP pretty paths
  (§10.1): they add reserved-name and collision machinery for ergonomics
  that completions already deliver — and a user who wants brevity has shell
  aliases. Revisit with customer evidence.
- **Completions & help:** shell completions for `cap run` — capability
  names and their flags — regenerate from the cache on sync, so
  discoverability matches hand-written commands. The REPL slash catalog
  derives from the same commander tree, so installed capabilities appear
  there too — the existing `slash-parity` tests extend to cover the dynamic
  set.

This keeps **one** distributed binary (`@oxagen/cli` on npm), no per-workspace
builds, and the workspace-specific behavior lives where the rest of this
design puts it: in the synced, signed capability index. What is genuinely
per-workspace is a cache file, not a compilation.

### 10.6 Docs surface

The `docs` layer stays mandatory: `docs/<action>.md` ships in the package,
renders on the capability's catalog page (with contract tables generated from
the compiled schemas, the way `capability.registry.get` derives field specs
today), and is exported by `system.install.instructions`-style copy blocks
(REST curl, MCP config for external runners, CLI invocation) generated from
the same declaration. Nothing is hand-synced.

---

## 11. Install & lifecycle

### 11.1 Validation pipeline (every path funnels through it)

On upload/build: unzip in an isolated worker → `integrity.json` digest check →
manifest schema parse (`capabilityPackageManifestSchema`) → namespace
ownership check → naming rules (§4) → schema portability re-verification (the
platform re-compiles and compares digests; the client's compiler is not
trusted) → bundle static checks (no `@oxagen/*` imports, no `node:` besides
the allowed set, size caps) → docs presence per capability → reserved
`ui/` / manifest-`ui` warning (§10.4 stub — warned and ignored, never
processed) → optional publisher policy checks (org-configurable: require review,
forbid `network`, cap sensitivity). Result: a `capability_package_versions`
row (`status: "validated"`) with the blob in private storage. Failures return
a structured report (the same report `cap doctor` prints locally).

### 11.2 Ways in (the "Compile/Package" processes)

1. **Local:** `oxagen cap build` + `oxagen cap publish` (CI-friendly; the
   scaffolded GitHub Action publishes on tag).
2. **Package Studio (in-app):** connect a repo (the GitHub app connection
   from ADR-027 / `repo.*` capabilities) → pick ref/tag → the platform runs
   `cap build` **inside a build sandbox** (Docker/Firecracker driver, network
   restricted to the repo host + registry mirror, resource-clamped) as an
   Inngest job → validation pipeline → version appears in the org registry
   with full Git provenance. Build logs stream to the Studio via the run
   view. This is the "process in the existing app to compile/package" — same
   validation funnel as local, so Studio vs laptop is a convenience choice,
   not a trust choice.
3. **Direct `.cap` upload** (app or `POST /v1/:org/:workspace/cap-packages`):
   for air-gapped or vendor-delivered packages; identical funnel.

### 11.3 Install, consent, enable

`install_capability_package { packageId, versionId?, workspaceId }` (Owner or
Admin; new first-party contracts — `install_capability_package`,
`uninstall_capability_package`, `activate_capability_package_version`,
`set_capability_package_enabled`, `list_capability_packages`,
`read_capability_package`) creates/updates the `capability_installs` row
**disabled by default** (the `plugin.org.install` precedent), shows the
consent screen rendered from the manifest — capabilities being added (with
sensitivity badges), permission grants, secret names required (with a
one-click path to create missing vault keys), egress hosts — and requires
explicit enable. Enabling seeds the declared `defaultRoles` grants through
the standard IAM seeding path and invalidates the resolver/entitlement
caches; the capability is live on every declared surface within the cache
TTL, no deploy.

### 11.4 Upgrade, rollback, uninstall, revoke

- **Upgrade** = activate a different immutable version
  (`skill.version.activate` semantics). The diff screen shows semver bump,
  CHANGELOG, contract schema diff (from schema digests), and **permission
  delta — any widening re-triggers consent**. Majors with breaking contract
  changes are flagged from the schema diff (removed/retyped fields,
  narrowed enums).
- **Rollback** = activate any prior validated version (immutability makes
  this trivial and fast).
- **Uninstall** soft-deletes the install; runs history is retained;
  role grants referencing the names become inert (text ids, nothing
  dangles).
- **Revoke** (publisher or platform trust action) flips a version's status;
  installs pinned to it are force-disabled with notification — the kill
  switch for a bad or malicious version. A platform-level
  `CAP_PACKAGES_ENABLED` env kill switch (registered in
  `packages/config/src/registry.ts` per house rule) disables all dynamic
  resolution instantly.

### 11.5 Upgrade blast radius on callers

Activating a version changes the contract *for everyone already calling
it*; the installer's diff screen (§11.4) is necessary but not sufficient:

- **Agent conversations** re-materialize tools each turn, so a running
  conversation picks up the new schema on its next step; a tool call
  already in flight completes against the version that dispatched it.
- **MCP clients** receive `notifications/tools/list_changed` (§10.2); a
  client that ignores it and sends stale arguments gets a structured
  `invalid_input` whose payload embeds the current compiled input schema —
  self-healing for schema-reading clients, diagnosable for everything else.
- **REST callers and automations are enumerable before the fact:**
  ClickHouse `tool_invocations` slices by capability name, so the
  activation screen shows a **consumer preview** — the surfaces, API keys,
  and automation triggers that invoked this capability in the last 30
  days — and flags contract-breaking majors against that live list. After
  activation, the first failed run per consumer raises a notification
  instead of failing silently inside a scheduler.
- **Compatibility rule enforced by validation:** a minor version must be
  accept-compatible (new optional input fields, additive output fields);
  anything that removes, retypes, or narrows is a major and turns the
  consumer preview into a blocking warning. Per-consumer version pinning
  (blue/green) is deliberately out of scope — one active version per
  workspace keeps the registry, IAM, and audit story simple.

---

## 12. Security model

Threats and their boundaries (defense-in-depth, each layer independently
fail-closed):

1. **Hostile handler code** → never in-process (§9.1); Firecracker/Docker
   isolation; policy-clamped CPU/memory/time; read-only bundle; no ambient
   credentials in the session (vault values are fetched per-call through the
   broker, not injected into env, unlike agent sandboxes' `setupEnv` — a
   deliberate tightening for code that runs unattended).
2. **Data exfiltration** → default-deny egress; `permissions.network`
   allow-list enforced by the sandbox network policy; the only always-open
   host is the platform broker endpoint.
3. **Privilege escalation via the platform** → every effect re-enters
   `kernel.invoke()` under the *invocation's* principal with the manifest
   allow-list intersected — a customer capability can never do more than
   (caller's IAM) ∩ (declared permissions) ∩ (workspace install consent).
   Approval-requiring capabilities still require approval when called from a
   runner. Invocation tokens are short-lived, single-invocation, audience-
   bound.
4. **Contract poisoning** → schemas are data (§7); the platform re-compiles
   and digest-compares at validation; Zod materialization never evaluates
   package code.
5. **UI XSS** → v1 renders installed capabilities exclusively through
   platform-registered components (auto-form + the curated set); customer
   UI bundles are inert (§10.4 stub). The future custom-UI spec must meet
   or exceed: sandboxed embedding, isolated origin, strict CSP, typed
   bridge. Stored-markup rules from the SVG pipeline apply unchanged.
6. **Supply chain** → immutable versions keyed by sha256 digests
   (`integrity.json` + `package_digest`); Git provenance recorded; runner
   images digest-pinned; Studio builds run network-restricted; revocation +
   kill switch (§11.4); vestigial-pattern note: this is the `skills-lock.json`
   idea done properly — hashes live in the platform registry, not a repo
   lockfile.
7. **Tenancy** → runner dispatch carries explicit `{orgId, workspaceId}`;
   all broker reads/writes run inside `runInTenantScope` + RLS
   (`withTenantDb`) exactly as first-party handlers do; packages are
   workspace-installed, org-owned, and never cross-tenant.
8. **Abuse/runaway** → per-org runner concurrency (Inngest org-keyed
   limits, the `agent.video-render` precedent), invocation rate limits at
   the API middleware, compute metering with bias-high pricing, run history
   auditability (`capability_runs` + ClickHouse invocation rows).

---

## 13. Migration & dogfooding: svg / image / video first

The media-generation capabilities are the starting line (they are already
"capability packs" in name — `oxagen/media-svg`, `oxagen/media-image`,
`oxagen/media-video` seeded per workspace by
`packages/handlers/src/workspace-capability-seed.ts` — but their packaging is
notional: manifests claiming compile-time contracts). They become real in two
steps:

**Step 1 — bind through the generic binders (no package format needed):**
mount `generate_svg`/`generate_image`/`generate_video` REST routes from the
route table (delete their three route files + six `app.ts` lines), serve
their MCP tools from the dynamic provider (delete three tool files), and
render `generate_svg`/`generate_image` through the generic runner page.
Gates: `route-contract-parity` and `tool-registry` tests re-pointed at the
binders; **byte-identical HTTP responses** asserted against recorded
fixtures; existing chat e2e unchanged. Then sweep the remaining ~273 route
files / ~327 tool files in mechanical batches under the same gates.

**Step 2 — re-express as `.cap` packages (trusted profile):** build
`oxagen/media-*` with `cap build` in-repo, install via the standard pipeline,
execute via the `trusted` profile (in-process, §9.1) so latency is unchanged.
This makes first-party packages the permanent conformance fixtures for the
customer pipeline — every release of the platform builds, validates,
installs, and invokes real packages in CI. `generate_video` additionally
migrates its bespoke pending-row flow onto the `capability_runs` envelope
(§9.5), becoming the reference async capability.

Only after both steps does the customer beta open (plan.md sequences this
with gates).

---

## 14. Open questions

1. **Runner driver and pool keying for v1 GA** — Modal durable sessions
   (shipped) vs Vercel sandbox sessions is the smaller half of the
   question; the real fork is **pool granularity**. Per
   (workspace × package version) pools give hard publisher isolation but
   idle N sandboxes for N installed packages; one per-workspace session
   hosting multiple bundles cuts the bill but puts different publishers'
   code in one process — cross-package secret exposure within a tenant.
   The Phase 2 spike must price both and pick a default (a plausible
   landing: per-workspace pooling for same-publisher packages only,
   per-package otherwise).
2. **`require_approval` UX for external MCP callers** — an external agent
   runner hitting a pending-approval response gets the JIT access-request id
   today; is polling acceptable for v1 or do we need MCP elicitation
   support?
3. **Custom-image publish scanning** — which scanner (Trivy vs driver-native)
   and which severity threshold blocks publish.
4. **Marketplace lane** — when packages go cross-org (Phase 4), does listing
   ride `workspace-scoped-marketplace`'s `installed_plugins` UX with a new
   plugin type card, or a dedicated packages catalog? (Both registries stay;
   the question is presentation.)
5. **Per-seat vs usage pricing for runner compute** — pricing owns this; the
   meters land either way (§9.6).
6. **CLI offline invocation** — is offline-after-sync enough, or do
   air-gapped fleets justify Option B (npm plugin emission) sooner?
7. **Org-level install** — Acme's refunds package is really an org
   capability; installing workspace-by-workspace is toil at 40 workspaces.
   `plugin.org.install_bulk` is precedent for the mechanic; the open design
   questions are defaulting (auto-install into newly created workspaces?)
   and whether org-level consent can bind workspace-level grants without
   eroding the workspace as the IAM boundary.

## 15. Out of scope (tracked elsewhere)

- Community/marketplace publishing and monetization — extends
  `workspace-scoped-marketplace` + `skills-marketplace` once v1 is stable.
- Non-Node runtimes; runner GPU classes.
- Mobile bindings for installed capabilities (ADR-026 parity extension).
- Agent-authored capability packages ("the agent writes and publishes a
  capability") — deliberately later; the human consent surface comes first.
