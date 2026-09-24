# Oxagen gateway: what remains to make it real

| | |
|---|---|
| **Status** | Draft for review |
| **Date** | 2026-09-18 |
| **Owner** | platform |
| **Builds on** | ADR-094 (the loopback model proxy), ADR-095 (the tier ladder), ADR-096 (the contained tier), ADR-078 (wrapped and connected), ADR-043 (Oxagen governs, it does not run) |
| **Related** | `docs/specs/tacho/spec.md`, `packages/tacho/README.md` section "The gateway", `oxagen-roadmap:docs/oxagen/specs/mission-control/spec.md` §8 |
| **Source** | Read at `main` after the merge that brought #3319 (Phase 4) |

---

## 0. The call sheet

| # | The gap | Earns | Section |
|---|---|---|---|
| G1 | The launcher that confines the process does not exist | `contained`, the only tier that may say enforced against a machine's operator | §3.1 |
| G2 | The harness can be pointed away from the proxy and nothing says so | Honest tiers, and a loud drift signal where prevention is not available | §3.2 |
| G3 | The proxy path and tool result bodies still ship no content | Tool results and proxy bodies you can read, under a policy you set | §3.3 |
| G4 | The product does not show the computed tier | A claim that carries its scope, per ADR-095 | §3.4 |
| G5 | A session that ran turns and routed no model call looks the same as one that routed every call | Detection where prevention is impossible | §3.5 |

Nothing in this document proposes a new architecture. ADR-094, ADR-095, and
ADR-096 decided the architecture on 2026-09-18. This is the delta between those
decisions and the code, in build order.

## 1. Where the gateway stands today

Phase 4 landed the loopback model proxy. `tachod` stands between a wrapped
harness and its model vendor, on a second loopback listener whose port is
`model_proxy_port` in `host.json`.

What it does, from `packages/tacho/src/collector/model-proxy.ts` and
`packages/tacho/README.md`:

| Capability | State |
|---|---|
| Observed metering: one `llm_call` frame per call, carrying the vendor's own usage, request and response digests, latency, and status | Built |
| An enforced session budget: `budget.session_limit_usd` compared with observed spend before a call is forwarded, refused in the vendor's own error shape, sealed as a `policy_decision` | Built |
| A real interrupt: a paused or cancelled session has in-flight calls aborted and new ones refused | Built |
| The injection seam `beforeForward(request) -> request` | Built, and a no-op until the assembler of ADR-093 exists |
| The MCP gateway for connected apps | Built (ADR-078), registered into Claude Desktop only |
| Hooks on Claude Code, Codex, and Stella: five blocking events, fail-closed, able to refuse | Built |
| Frame bodies under a workspace's retention mandate, on the hook path | Built (#3332), see §3.3 |

Two properties of the proxy are load-bearing for everything below, and both are
deliberate (ADR-094, amended by ADR-143). The vendor credential stays on the
machine and Oxagen's servers never hold it: on a brokered provider the gateway
holds it in custody under `TACHO_HOME` and the harness holds a run token; on a
harness-held provider it crosses in memory, forwarded untouched. Prompt bodies
go to the vendor the harness chose and never to Oxagen. Only the frame goes up.

| Capability | State |
|---|---|
| The credential seam: `tacho enroll` takes the vendor key into the gateway's custody, Claude Code's `apiKeyHelper` and Codex's `auth.json` hold run tokens, the proxy verifies and swaps, refuses a foreign credential, and records `oxagen.credential_basis` on every frame | Built (ADR-143) |

## 2. What unpluggable can mean, and where

ADR-096 states the constraint plainly: on a laptop the developer owns, nothing
is enforceable against the owner. A mandatory sandbox there buys friction, not
security. Enforcement means something where the operator is not the machine
owner, which is CI, headless runs, cloud runners, and managed devices. That is
also where unattended risk lives.

So "impossible to unplug" is not one build. It is two, and they are not
interchangeable:

1. **Where Oxagen launches the process** it can confine it, and removal costs
   an escape from a sandbox rather than an edit to a settings file. This is the
   `contained` tier, and it is the only tier ADR-095 allows to say "enforced"
   against the machine's operator.
2. **Everywhere else** the controls stay client-attested and the honest product
   move is detection: say what was routed, say what was not, and make a machine
   whose configuration drifted visible within one poll.

A control plane that claimed prevention at tier two would be claiming something
the record cannot back.

## 3. The gaps

### 3.1 G1: the launcher (ADR-096, Phase 5)

`oxagen run -- <agent>` does not exist. `apps/cli/src/commands/run.ts` holds
`oxagen run export <run-id>` and nothing else.

ADR-096 names three controls, and a run whose attestation lacks any one of them
is not `contained`:

1. **Gateway-only egress.** Every model and MCP request from every process in
   the sandbox reaches the gateway or fails.
2. **A filesystem policy.** The writable set is the workspace the launcher was
   given. The harness's settings file, its hook entries, and the `tacho-hook`
   binary are read-only for the life of the run.
3. **Hook integrity at launch.** The launcher starts the binary it chose with
   the hook entries it wrote, records a digest of that configuration, and the
   sandbox denies writes to it.

Gateway-only egress on its own is not enough, and the reason is worth keeping
in front of whoever builds this. The harness's built-in tools run inside the
sandbox. A process in there can edit the settings file, set `disableAllHooks`,
or start a second copy of the harness without hooks. Egress confinement does
nothing about that, which is why control 2 and control 3 are not optional.

Scope for the first build: Linux CI runners, because that is where the first
target population runs. The OS mechanism per platform is a Phase 5 choice and
ADR-096 does not decide it. The `--` form is the launcher; `oxagen run export`
keeps parsing.

### 3.2 G2: base URL integrity on the harness tier

`packages/tacho/src/host/model-base-url.ts` writes `ANTHROPIC_BASE_URL` into
the harness's settings and `openai_base_url` into `~/.codex/config.toml`. Both
are settings the person on the machine can change back, and today nothing
notices when they do.

Three pieces, none of which claims prevention on a machine the operator owns:

1. **Managed settings take precedence where they exist.** The reader already
   reports a managed value as `shadowedBy`. On a fleet under MDM, the base URL
   and the hook entries belong in the root-owned managed settings file, where
   the person at the keyboard cannot edit them, and enrollment should write
   them there when it can.
2. **Drift is a signal, not a silence.** The daemon compares the base URL and
   the hook entries it installed against what is on disk on each control poll,
   and reports a mismatch as a first-class host condition, not a log line.
3. **The signal reaches a person.** A host whose configuration drifted appears
   as such on the Fleet page and can raise a notification. Security set the
   mandate, so security learns when the machine stopped honouring it.

### 3.3 G3: the body producer

The wire already carries bodies. `tachoBodySchema` and the `bodies[]` field on
the batch are defined in `packages/tacho/src/wire.ts`, with a 1 MiB ceiling per
body, and the control plane verifies the digest, refuses bytes its own
detectors would redact, and answers with `body_rejections`. The redaction layer
exists in `packages/tacho/src/evidence/redaction.ts` and records every removal
as `{path, reason, original_digest}`, so a redacted body still verifies against
its digest.

Three things were missing, and between them they made the whole policy inert.
The first two are closed on the hook path:

- **The digest could not be satisfied.** The host digested a frame's content
  before redaction, and the control plane requires a body's bytes to hash to
  the chained digest *and* to carry no credential. Redacted bytes failed the
  first check, raw bytes failed the second. `contentFrameOf` redacts first
  now, in every retention mode, and `content.redactions` records what was cut.
- **Nothing read `retention`, and nothing produced bodies.** The collector now
  reads the mandate at the moment a frame is sealed, keeps the redacted bytes
  when both halves of it allow, and ships them in `bodies[]`. The shipper
  drops a body once its batch is acknowledged, whether the control plane
  stored or refused it, and a mandate that narrows drops what is already on
  disk rather than racing the drain. A mandate that cannot be proven — an
  unverifiable bundle, or one past its signed window — withholds the body but
  keeps it, because that condition is usually transient and a purge is not: a
  control plane outage lapses every cached bundle at once, and purging on that
  signal would turn an outage into permanent loss of the evidence this host
  exists to keep.

What remains under G3:

- **The proxy path.** Phase 4 added a second place this decision has to be
  made. The hook path sees prompt text and tool bodies. The proxy sees request
  and response bodies, and ADR-094 decided it keeps them on the machine.
  Whether `content_exact` changes that is a decision this spec does not make,
  and it should be made explicitly rather than by whoever writes the code
  first.
- **Tool result bodies on the hook path.** `tool_call` frames map to the
  `tool_call` content class and nothing writes their bodies yet, so a
  workspace that authorised that class still receives digests for it.

One rule decides at both ends. `retainsBody` in `@oxagen/tacho` reads the mode
and the classes together, the collector calls it before it writes, and the
ingest handler calls it before it accepts, answering `retention_class_excluded`
for a body the mandate does not cover. Reading the mode alone would keep a
prompt for a workspace that authorised tool results and nothing else, and an
empty class list authorises nothing rather than everything.

### 3.4 G4: the tier a run earned, on the surface

ADR-095 says a tier is computed from what was routed, never assigned, and that
every control claim carries its scope: "for actions routed through Oxagen". The
product has to show the computed word, show `contained` and `gateway` as not
yet available where they are not, and claim no model proxy, observed metering,
enforced budget, real interrupt, or sandbox as present until the record shows
one. A surface that reads a tier off what was installed on the host is reading
the wrong thing.

### 3.5 G5: detection where prevention is not available

A session that ran turns and routed no model call through the gateway went
around the proxy. That comparison is available from the record today and
nothing makes it. It belongs next to the drift signal of §3.2: one honest
answer to "is this machine actually reporting", rather than a green dot that
means "a daemon is running".

The rule has to name the evidence precisely or it becomes noise. A session
where someone opened the harness and closed it without submitting anything
records `SessionStart` and `SessionEnd` and nothing else, and it made no model
call because there was nothing to ask. Reporting that as a bypass would teach
the operator to ignore the signal.

So the comparison is between a session's turns and its routed calls, not
between its existence and its routed calls:

| What the record shows | Reading |
|---|---|
| Turn frames, and `llm_call` frames at `fidelity: proxy` | Routed. The tier is computed from these. |
| Turn frames, and no `llm_call` frame at proxy fidelity | Went around the proxy. Raise it. |
| No turn frames | The session asked nothing. Not a bypass, and not a tier claim either. |

A turn that ended in an error before any request left is the edge worth a test:
it carries a turn frame and legitimately has no model call, so the rule reads
the turn's outcome before it raises anything.

## 4. What is not here

- **Oxagen's servers holding or minting the vendor credential.** ADR-094
  rejected it on 2026-09-18, with reasons that still hold: a cloud-hosted proxy
  adds a hop and an availability dependency, it puts every prompt body and
  every customer's source code through Oxagen's network, and it moves the
  vendor credential off the machine or forces a second one. Custody on the
  machine is a different question, and ADR-143 answered it on 2026-09-22: the
  gateway daemon holds the key and the harness holds a run token. That is the
  ADR §1 cites. The contained tier still reaches unpluggability by confining
  egress; custody makes the bypass a key recovery rather than a one-line edit.
- **Re-specifying the proxy.** It is built. Only the delta is here.
- **A per-workspace or per-session model key.** `docs/specs/model-funding-source/spec.md`
  §5 rules the first out. The second has no decision behind it.
- **The witness protocol.** `oxagen-roadmap:docs/oxagen/specs/tacho/witness-protocol.md` is a separate
  line of work and does not block any gap above.

## 5. Build order and acceptance

| Order | Gap | Done when |
|---|---|---|
| 1 | G2 drift detection and the managed-settings path | A machine whose base URL or hook entries were changed reports the mismatch within one control poll, and the Fleet page shows it. Enrollment writes to managed settings where the platform has them. |
| 2 | G5 unrouted-session detection | A session carrying turn frames and no `llm_call` at proxy fidelity is identified in the record and surfaced with the drift signal. A session with no turn frames, and a turn that failed before any request left, raise nothing, and both are covered by tests. |
| 3 | G4 computed tier on every surface | Every surface that names a tier reads the computed value, shows the two unavailable tiers as unavailable, and carries the scope phrase. |
| 4 | G3, the rest | Tool result bodies ship on the hook path, and the proxy-path decision is recorded as an ADR. The hook path's prompt and response bodies are done. |
| 5 | G1 the launcher | `oxagen run -- <agent>` confines a run on a Linux CI runner with all three controls, attests to each, and the run computes as `contained`. A run missing any control computes as `gateway` at most. |

G2, G5, and G4 come first because they cost little, they are honest about a
tier that cannot prevent, and a customer can feel them on the machines they
already have. G1 is the largest build and the only one that earns the word
enforced.
