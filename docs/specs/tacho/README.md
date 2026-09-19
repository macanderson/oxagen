# Wrapping an agent

Oxagen governs agents; it does not run them (ADR-043). Wrapping is how it
reaches the ones it does not run: the agent's own harness reports what it did,
and Oxagen records, gates and evidences that from the outside. The thing has no
product name. Doing it is wrapping an agent (spec §2.1).

`spec.md` (Proposed, 2026-09-06) is the Oxagen contract for it. `@oxagen/tacho`
is the package that implements the wrapper, with one enrollment contract, one
evidence contract and one control contract that Stella meets natively. Four
harnesses are wrapped as equals (`WRAPPED_HARNESSES`,
`packages/tacho/src/wire.ts`, and ADR-101): Claude Code, Codex, Cursor and
Stella, each through the hooks its harness reads, with Cursor's and Stella's
payloads translated by `cursor-adapter.ts` and `stella-adapter.ts`. A custom
agent wraps itself through `tacho.wrap(...)`. Claude Desktop is connected
rather than wrapped (ADR-078).

`plan.md` sequences the build. `design/` holds the product design (trace model,
approval tokens, trust scoring, threat model, insurer API) and its three
decision records, `adr-0003` through `adr-0005`.

## The names that are still moving

Spec §2.1 takes the old word off the surfaces, and ADR-112 lands that in phases
because several of these names are recorded on machines that are already
enrolled. Until those phases ship, the documents in this directory name what
exists:

| Name | What it is | Phase that moves it |
|---|---|---|
| `oxagen agent enroll \| status \| unenroll` | The commands. Already moved; `oxagen tacho` is hidden, still works, and prints one deprecation line. | 1a and 1b, shipped. The old spelling retires on an announced CLI window, not on the fleet's clock: a runbook holding it learns nothing from a host re-enrolling. |
| `tachod`, `tacho-hook` | A user service and a hook binary path, written into harness settings and into managed settings documents that MDM has distributed. | 4, new name alongside the old, migrating on the next enroll |
| `/v1/tacho/enroll` and the `/v1/tacho` group | Deployed API routes an enrolled host calls to enroll, ingest events, fetch its bundle and fetch commands. The host does not choose them: the server issues them at enrollment, from `TACHO_INGEST_ENDPOINTS` or a default constant. | 4 adds the `agent` paths beside them. When the old ones stop answering is open: nothing records which path a host calls, and a normal re-enroll keeps a host's existing endpoints. ADR-112 phase 4 has the questions. |
| The seven organization-scoped `/tacho/` paths | Published API, reached as `POST /v1/:org_slug/:workspace_slug/tacho/...`, and called by operators, scripts and integrations rather than by a host. All seven have a capability document; two also publish an MCP tool or a CLI command. | 4 adds the `agent` paths, but the old ones answer until an announced API deprecation window closes, independent of the fleet. A host re-enrolling does not update a caller's script. |
| `tacho/1.0` | The envelope version on the wire between hook, collector and server. `TACHO_ENVELOPE_VERSION` in `packages/tacho/src/envelope.ts` accepts this literal and no other, so a producer sends this today. | 5 adds `oxagen.frame/1.0` beside it and the collector reads both indefinitely. This literal is not retired on a release count and may never be: an installed collector has no upgrade signal, the request validator rejects a whole batch, and a sealed WAL entry cannot be rewritten. `envelope.ts` records the same finding for the legacy `user_email` member. |
| the `tacho` Postgres schema | The schema, not one table. `tacho.ts` declares 10 tables on it and the migrations create `"tacho"."sessions"`, `"tacho"."hosts"` and the rest, so the word qualifies all 10. `tacho_sessions_runtime_check` is a constraint name, and no `tacho_sessions` table exists. | None. Drafts through 2026-09-19 gave it a phase 6; `_schemas.ts:36` is a compile-time `pgSchema("tacho")` so both names cannot resolve at once, `ON CONFLICT` on the ingest path rules out a view-based bridge, and no customer reaches a schema name. ADR-112 has the ledger. |
| `@oxagen/tacho`, and the seven registered capability names carrying the word | A package name, and the capability names `create_tacho_enrollment`, `revoke_tacho_enrollment`, `ingest_tacho_events`, `get_tacho_bundle`, `list_tacho_hosts`, `list_tacho_sessions` and `get_tacho_session`. `list_tacho_hosts` is the only one on MCP; the other six declare `surfaces: ["api"]`. | None. ADR-112 decision 1 keeps them, and ADR-025 retired the dotted form with no alias fallback, so a rename breaks every caller at once. |

## The Stella-side seam corpus (copied)

The remaining files in this directory are copied verbatim from
`macanderson/stella` at commit `0cb26c5e0835aa79e70674d723575871c5ca52fd`
(`docs/spec/*`) on 2026-09-07. Stella is the reference implementation of the
Context Graph Protocol and of the trace vocabulary `spec.md` §6 ingests; these
documents define the seam Stella already speaks. They are copied, not linked,
so both sides of the contract are versioned in the repository that implements
the Oxagen half. When Stella revises one, re-copy and bump the commit above.

| File | What it defines | `spec.md` consumer |
|---|---|---|
| `oxagen-trace-drain.md` | Full-fidelity egress: `AgentEvent` journal to content-bearing drain to Oxagen's three storage planes, column-level mapping | §6 evidence contract, `ingest_run_evidence` |
| `session-telemetry-receipts-spec.md` | Per-session receipts: what was sent to the model, tool-call preimages, digests | evidence manifests, replay grade |
| `enterprise-authority-telemetry.md` | Authority model (managed ceiling ∩ repo trust ∩ session grant), content-free rollup, signed enrollment | §5 enrollment, IAM delegation ceiling |
| `witness-protocol.md` | The flip oracle (fail to pass of the same normalized command), tamper exclusion, deterministic-first ladder | the trace-level pass/fail stamp |
| `verification-gate.md` | `Completed` vs failed, aborted, or indeterminate | outcome on execution records; trust input |
| `step-grading-and-productive-ratio.md` | Per-step grading and the productive ratio | `design/trust-scoring.md` |
| `wrapper-socket.md` | The plugin socket a turn-loop wrapper plugs into | `design/examples/rust-stella.md` |
| `agent-monitor-protocol.md` | One JSON line per detection from any run watcher to any supervisor | fleet monitor ingress |
| `serve-observability.md` | What `stella serve` exposes for observation | §7 control contract (reverse-RPC tier) |

Oxagen's ledger side of this seam is `docs/specs/run-evidence-ingress/spec.md`
(Approved) and `@oxagen/run-ledger`. The excision that made the wrapper the
only agent surface is ADR-043.
