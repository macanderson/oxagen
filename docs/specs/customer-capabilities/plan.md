# Customer-Built Capability Packages — Delivery Plan

**Spec:** `docs/specs/customer-capabilities/spec.md` · **ADR:** ADR-034
**Status:** Awaiting spec sign-off (do not start Phase 1+ before that; Phase 0
is independently justified boilerplate deletion and may start immediately
after review of its gates)

Sequencing principle: **binders before packages, first-party before
customers.** Every phase ends with the platform in a shippable state; no phase
depends on an unshipped later phase. Phases 2 and 3 have partial overlap
opportunities noted inline.

---

## Phase 0 — Surface binders, dogfooded on media capabilities

*Deletes first-party boilerplate; creates the machinery installed packages
will ride. No new product surface.*

| # | Work | Where | Exit gate |
|---|---|---|---|
| 0.1 | Workspace-aware enumeration API: `capabilitiesForSurfaceInWorkspace(surface, scope)` (static-only at this phase) | `packages/oxagen/src/kernel.ts` | Unit tests; API used by 0.2–0.5 only |
| 0.2 | REST route table: registry-driven mounting preserving current paths (adr025 name-map for legacy dotted paths); generic `POST /v1/:org/:workspace/cap/:name` dispatch route | `apps/api` | **Byte-identical responses** for `generate_svg`/`generate_image`/`generate_video` against recorded fixtures; `route-contract-parity.test.ts` re-pointed at the table; 3 route files + 6 `app.ts` lines deleted |
| 0.3 | MCP dynamic tool provider (static registry set): programmatic `tools/list`/`tools/call`; xmcp-hosted if possible, official MCP SDK fallback (spec §10.2) | `apps/mcp` | `tool-registry.test.ts` asserts provider ⊇ mcp-surfaced contracts; MCP inspector parity snapshot (name/description/schema) vs the 3 media tool files, then files deleted |
| 0.4 | Field-description migration: move MCP `.describe()` overlays into contracts for the media capabilities (pattern for the later sweep) | `packages/oxagen/src/contracts` | Schema snapshot diff reviewed; no description regressions |
| 0.5 | App generic capability runner page (auto-form from compiled schema → generic server action → `resolveRenderDirective` pipeline); auto `capability-ui-map.json` emission | `apps/app` | `generate_svg`/`generate_image` runnable end-to-end from the page; `check:ui-parity` green; e2e for one sync + screenshot |
| 0.6 | Mechanical sweep: remaining REST route files + `app.ts` mounts + MCP tool files onto the binders, in reviewable batches (~40/PR) | `apps/api`, `apps/mcp` | Full fixture parity suite green per batch; `pnpm gate` green; final state: 0 per-capability wrapper files |

**Phase exit:** adding a first-party capability = contract + handler + tests +
doc; parity gates verify the binders, not files.

## Phase 1 — Package format, SDK, toolchain (no server-side execution yet)

| # | Work | Where | Exit gate |
|---|---|---|---|
| 1.1 | `capabilityPackageManifestSchema` (`kind: "oxagen.capability-package"`, formatVersion 1) extending `oxagenPluginManifestSchema`; shared naming validator extracted to `packages/oxagen/src/naming.ts` (consumed by `check-naming.mjs` + pipeline) | `packages/oxagen` | Schema unit tests incl. namespace/action rules; `check-naming.mjs` behavior unchanged on the repo |
| 1.2 | Portable-schema compiler: Zod→JSON Schema with hard subset enforcement + digest; JSON Schema→Zod materializer (data-only) | new `packages/cap-format` | Round-trip property tests over all 349 in-repo contract I/O schemas (the subset-coverage claim in spec §7 is CI-proven) |
| 1.3 | `@oxagen/cap-sdk`: `defineCapability`/`defineHandler` types + host API type surface (v1.0) | new package (published) | Type-level tests; example repo compiles |
| 1.4 | `@oxagen/cap-cli`: `cap init/build/doctor/test` (build+validate local-only; `dev`/`publish` land with their server pieces) | new package (published) | `cap build` of the example repo emits a `.cap` that the 1.5 pipeline validates byte-for-byte |
| 1.5 | Validation pipeline as a library (unzip-in-worker, digest, manifest, naming, schema re-compile+compare, bundle static checks, docs presence) | `packages/cap-format` | Adversarial fixture suite: tampered digest, `@oxagen/*` import, non-portable schema, undeclared permission probe — all rejected with structured reports |
| 1.6 | Rebuild `oxagen/media-svg|image|video` as real `.cap` fixtures with `cap build` (not yet installed anywhere) | `packages/oxagen/src/plugins` | Fixtures build reproducibly in CI; digests stable |

## Phase 2 — Registry overlay, runner, install lifecycle (private beta)

*2.A (data + resolution) and 2.B (runner) can proceed in parallel; 2.C needs
both.*

| # | Work | Where | Exit gate |
|---|---|---|---|
| 2.A1 | Tables: `capability_packages`, `capability_package_versions`, `capability_installs` (+ `capability_runs`); hand-written SQL migrations per atlas house rules; `capability_package` asset kind (50 MiB) | `packages/database`, `packages/storage` | `db:atlas-validate`; RLS policies reviewed |
| 2.A2 | `setDynamicCapabilityResolver` kernel seam + workspace cache (TTL + event invalidation); entitlement-service union over `capability_installs`; `capability.registry.*` overlay read-through | `packages/oxagen`, `packages/plugins` | Kernel tests: static wins, disabled/uninstalled → `capability_not_installed`, cache invalidation on lifecycle events; `materialize-tools` fail-closed test extended |
| 2.B1 | Runner image (`oxagen/cap-runner`, digest-pinned) + supervisor (`cap-call` protocol) + warm session pools on sandbox durable sessions + reaper integration | new `packages/cap-runner`, `packages/sandbox` | Docker-driver e2e: cold + warm invocation; policy clamps proven (timeout, memory, egress deny) |
| 2.B2 | Host broker: `POST /v1/runner/host`, scoped invocation tokens, `ctx.invoke/secrets/ai/storage/log` with permission intersection + re-entry depth cap; runner compute metering + rate-card entries | `apps/api`, `packages/oxagen`, `packages/billing` | Security tests: undeclared capability/secret/host denied at broker AND kernel; token replay/expiry/audience tests; metered rows land in ClickHouse |
| 2.B3 | Async envelope: `cap/execute` Inngest fn, `capability_runs` lifecycle, `read_capability_run` contract on all surfaces | `packages/inngest-functions`, `packages/handlers` | Async fixture package runs queued→succeeded/failed with progress; cancellation works |
| 2.C1 | Install lifecycle contracts (`install_capability_package`, `activate_…_version`, `set_…_enabled`, `uninstall_…`, `list/read_…`) + consent screen + IAM default-grant seeding + upgrade permission-delta re-consent + revoke/kill-switch (`CAP_PACKAGES_ENABLED` in env registry, `pnpm env:check --write`) | `packages/handlers`, `apps/app`, `packages/config` | Full lifecycle e2e: upload→validate→install→consent→enable→invoke on all four surfaces→upgrade→rollback→revoke; audit rows verified |
| 2.C2 | Beta hardening: per-org runner concurrency, API rate limits, run history UI (runs list + detail w/ logs), upgrade **consumer preview** (spec §11.5, from ClickHouse `tool_invocations`) | `apps/api`, `apps/app` | Load test at beta scale; runaway-package drill (revoke under load) |
| 2.C3 | `cap dev` local loop: docker runner + surface emulator + local host broker with **fixture** and **live-proxy** modes (spec §6.3) — beta-blocking, promoted from Phase 3 | `packages/cap-cli`, `packages/cap-runner` | External-author walkthrough doc; cold-start-to-first-invoke < 5 min; fixture-mode runs are CI-hermetic |

**Phase exit / beta gate:** the Acme example package (developed against
`cap dev`, built from a real external repo in CI) installs into a fresh
workspace and serves **REST, MCP (external client), agent tool, and the app
runner page** with IAM, billing, audit, and revocation
demonstrated. Media `.cap` fixtures
install via the `trusted` profile with zero latency regression
(spec §13 step 2); `generate_video` migrated onto `capability_runs`.

## Phase 3 — Authoring polish & remaining surfaces

| # | Work | Exit gate |
|---|---|---|
| 3.1 | Package Studio: Git-connected sandboxed builds (Inngest job, streamed logs, provenance) | Build from a private GitHub repo tag → validated version, no local toolchain |
| 3.2 | Workspace OpenAPI export (`export_openapi_document`) | Generated doc validates; installed caps present |
| 3.3 | Publisher policy controls (org-level: require review, forbid egress, sensitivity ceiling) + custom runner images (scan gate — resolve open question 3) | Policy matrix tests |

Custom UI components are deliberately **not scheduled** in this plan — the
lane is stubbed in spec §10.4 (reserved `ui/` dir, warn-and-ignore) and ships
only behind a dedicated spec + security review.

## Phase 4 — Marketplace lane (separate spec revision)

Cross-org distribution, verified publishers, listing UX (resolve open
question 4 with `workspace-scoped-marketplace`), pricing/rev-share. Explicitly
out of v1.

---

## Risks & mitigations

- **Binder behavior drift during the Phase 0 sweep** — recorded-fixture
  byte-parity per batch; small reviewable batches; both parity tests stay red
  until re-pointed, never deleted first.
- **Warm-pool economics unknown** (open question 1) — Phase 2.B1 includes a
  cost/latency spike on Modal vs Vercel sessions **and must resolve the
  pool-keying fork** (per (workspace × package version) isolation vs
  per-workspace multi-bundle sessions, spec §14.1) before pool defaults are
  fixed; `trusted` profile keeps first-party unaffected regardless.
- **Schema-subset gaps** discovered by real authors — the 1.2 property suite
  over all in-repo contracts front-loads this; subset extensions are additive
  formatVersion-compatible changes.
- **xmcp dynamic-provider feasibility** — 0.3 timeboxes the xmcp-hosted
  attempt; the MCP-SDK fallback is pre-approved in the spec so the phase
  cannot stall on a framework limitation.
- **Untrusted-code incidents in beta** — beta is allow-listed orgs;
  revocation drill is a 2.C2 exit criterion, not an afterthought; kill switch
  is env-registry-registered from day one.
