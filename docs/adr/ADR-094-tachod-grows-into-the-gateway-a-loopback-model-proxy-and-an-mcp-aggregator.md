# ADR-094: tachod grows into the gateway: a loopback model proxy and an MCP aggregator

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** platform, desktop
- **Decided by:** the maintainer, 2026-09-18, approving the architecture review
  of the same date in full
- **Related:** ADR-056 (run controls; "the model proxy is its own decision", and
  this ADR is that decision), ADR-078 (the MCP gateway is a proxy, not a second
  materialiser), ADR-043 (Oxagen does not run turns), ADR-047 (handle provider
  divergence at the gateway), ADR-052 and ADR-060 (the meter and spend),
  ADR-080 (Stella is wrapped through its hooks), ADR-092, ADR-093, ADR-095,
  ADR-096, the Mission Control spec section "The three seams" (§7), the Tacho
  spec
- **Delivered by:** Phase 4, in build now, in parallel with Phase 0 (PR #3289).
  Build order is Phase 0 in review, Phase 4 in build, then Phases 1, 2, 3, 5

## Context

Checked at `main` `02278c913`.

- **No model proxy exists.** There are zero source hits for
  `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or `/v1/messages` outside docs.
  ADR-056 says so plainly. The Mission Control spec's section on the three
  seams describes the proxy, base URL enrollment, run tokens and proxy budgets
  as present. That is docs only.
- Wrapping is not a supervisor. `oxagen tacho enroll` writes hook entries into
  the harness's settings file and installs the `tachod` daemon. No command
  launches the agent.
- `tachod` already exists, already listens on a Unix socket and on
  `127.0.0.1` (`packages/tacho/src/collector/server.ts`), already receives
  telemetry, and already hardens the loopback listener against DNS rebinding
  (`loopback-guard.ts`, ADR-078).
- Five hook events run as command hooks (`SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PermissionRequest`, `Stop`; `COMMAND_HOOK_EVENTS` in
  `packages/tacho/src/host/settings-writer.ts`). Four of them can refuse. With
  an empty bundle, `PreToolUse` can deny only on host status, a paused or
  cancelled run, a deny-generation bump or a stale bundle.
- The MCP gateway (`packages/tacho/src/collector/mcp-gateway.ts`) is real and
  server-enforced, and it is registered only into Claude Desktop
  (`CONNECTED_HARNESSES = ["claude-desktop"]`, `packages/tacho/src/wire.ts`). A
  wrapped Claude Code still talks to every other MCP server directly.
- Token and cost numbers for Claude Code are the harness's own OpenTelemetry
  export: self-reported. Codex has no OpenTelemetry export
  (`packages/tacho/README.md`) and neither does Stella, so their spend is absent
  from the record with nothing on the page saying so.
- `budget.mode` is always `"observed"` and `session_limit_usd` is read by
  nothing. `interrupt` degrades to `next_step` with
  `degraded_reason = harness_tier`
  (`packages/handlers/src/tacho.command.dispatch.ts`).
- Bypass at the hook tier: delete the hook entry, set `disableAllHooks`, kill
  the daemon, add another MCP server, or run the harness elsewhere. Detection is
  after the fact.

**Validated by the maintainer on 2026-09-18:** both OpenAI and Anthropic work
through a base URL proxy, subscription logins included, and neither vendor's
terms explicitly forbid it. The review listed this as its one unverified risk.
It is closed, and it does not gate Phase 4.

## Decision

`tachod` grows into the gateway. It has four parts:

1. the **hook adapter** (exists);
2. a **loopback model proxy**: Anthropic Messages and OpenAI Responses
   passthrough with streaming; enrollment writes the base URL;
3. an **MCP aggregator**: re-serves the harness's existing MCP servers through
   loopback, displace-and-restore;
4. the **control channel** (exists).

Prompt bodies never leave the machine; only digests and usage go up. The vendor
credential stays on the machine. Metering becomes **observed** instead of
self-reported, for every harness. `session_limit_usd` is enforced, per-turn
volatile injection re-lands at the proxy, `interrupt` becomes real.

### Why loopback

- **No extra hop.** The daemon is already on the machine and already on the
  path of every hook. There is no new availability dependency on Oxagen's
  cloud: if the control plane is unreachable, model traffic still flows.
- **Prompt bodies stay on the machine.** Oxagen does not take custody of every
  customer's source code in transit.
- **The vendor credential stays on the machine.** The proxy forwards the
  harness's own authorization header. Oxagen never holds it.
- **Observed metering for every harness.** Usage is read from the vendor's
  response, so Codex and Stella are metered the same way Claude Code is.

### What Phase 4 ships, and in what order

Phase 4 starts now: the loopback model proxy in `tachod`, enrollment writing the
base URL, observed metering, the enforced session budget, real `interrupt`, and
the desktop installer updated to install and remove the gateway cleanly. The
desktop app gets a line-by-line bug review in the same effort, with install and
uninstall fixed and proven by tests.

Per-turn volatile injection at the proxy lands when the Phase 1 assembler
(ADR-093) exists. The proxy ships the seam for it.

The MCP aggregator uses the displace-and-restore logic
`packages/tacho/src/host/mcp-config-writer.ts` already has. Where a vendor
offers managed settings, Oxagen pins them (ADR-078 §3).

Bundle permissions are filled from the second compilation (ADR-092 §3).

## Consequences

- ADR-043 holds. The proxy forwards a request a harness made. It assembles no
  turn, picks no model and holds no credential. ADR-078 §4's leaf constraint on
  `@oxagen/tacho` holds too: the proxy imports no `@oxagen/*` runtime package.
- A run's tier is computed from what was actually routed (ADR-095). A host with
  the proxy installed and a harness that bypassed it is not on the `gateway`
  tier for that run.
- "Enforced" applies to budgets on routed traffic. Against the machine's
  operator the gateway is still removable: unset the base URL and the traffic
  goes direct. Only the contained tier (ADR-096) closes that.
- `unenroll` must restore the base URL and every displaced MCP entry exactly.
  An installer that leaves a dead base URL behind breaks the harness, which is
  why install and uninstall are proven by tests in the same effort.
- The Mission Control spec's proxy sections stop being ahead of the code as
  Phase 4 lands. Until then they are marked as the target by the spec owners.
- Provider divergence (ADR-047) gains its second home: the loopback proxy sees
  both vendors' wire formats.

## Supersedes and amends

- Closes the decision ADR-056 §1 left open ("the model proxy is its own
  decision").
- Amends ADR-078: the `gateway` tier stops meaning only "an Oxagen MCP server in
  a connected app's config". See ADR-095.
- Amends ADR-051: per-turn injection re-lands here.

## Alternatives considered

**A cloud-hosted proxy.** Rejected. It adds a hop and an availability
dependency, it puts every prompt body and every customer's source code through
Oxagen's network, and it moves the vendor credential off the machine or forces
a second one.

**Hooks only, no proxy.** Rejected. A hook runs inside a process the user owns,
so hooks alone never earn the word "enforced", cannot meter Codex or Stella, and
cannot stop a run on a budget.

**Remove hooks once the proxy exists.** Rejected. Hooks see what the proxy
cannot: the harness's built-in Bash and Edit, permission requests, session
boundaries. They are also the only tier a developer's own laptop needs.

**Sandbox only.** Rejected in ADR-096.
