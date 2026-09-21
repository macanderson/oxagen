# Oxagen local supervisor: what a confirmed steer and a complete recording require

| | |
|---|---|
| **Status** | Draft for review |
| **Date** | 2026-09-21 |
| **Owner** | platform |
| **Builds on** | ADR-043 (Oxagen governs, it does not run), ADR-091 (one record steers one agent), ADR-094 (the loopback model proxy), ADR-095 (the tier ladder), ADR-096 (the contained tier), ADR-097 (steering and gating are two planes) |
| **Related** | `docs/specs/gateway/spec.md` (gaps G1 to G5), `docs/specs/tacho/spec.md` §7.4, `docs/specs/oxagen-desktop/spec.md`, `packages/tacho/src/collector/inbox.ts` |
| **Source** | `/Users/macanderson/Projects/oxagen-arp`, `reference/ARP-0.2-technical-reference.md` §9, §9A, §23A to §23E, read 2026-09-21 |

---

## 0. The call sheet

You can already pause, cancel, and steer an enrolled agent from the control
plane. `packages/tacho/src/collector/inbox.ts` applies the command, chains an
`oxagen:command_applied` event, and acknowledges it. What you cannot do is show
that a pause actually stopped anything, that a steer reached the turn it claims
to have reached, or that a recording covered every model call in a session.

This document is the delta between those three claims and the code. It imports
one outside design, the local Supervisor specified in the oxagen-arp document
pack, and keeps only the parts that hold under ADR-043.

| # | The gap | Earns | Section |
|---|---|---|---|
| S1 | `pause` acknowledges `applied` without a confirmed boundary, and `cancel` acknowledges `applied` when the kill failed | A pause state you can act on | §3.1 |
| S2 | No ordering point decides whether a command or the next dispatch came first | A steer that lands at a known boundary | §3.2 |
| S3 | A reply from an interrupted request can rejoin the transcript | An interruption that holds | §3.3 |
| S4 | A steer receipt names no request digest | A receipt that says where the text went | §3.4 |
| S5 | Fan out is host local, with no durable operation across devices | One steer across a fleet, with per target status | §3.5 |
| S6 | Capture completeness is uncontracted, so a partial recording looks whole | A recording whose gaps are named | §3.6 |
| S7 | `tachod` runs as the same user as the agent it supervises | A control the agent cannot switch off | §3.7 |

S7 is the one that decides what the other six are worth. Everything above it is
client attested until it lands. That is ADR-095 working as designed, not a
defect, and the spec says so at every claim.

## 1. What is built today

Read this section before writing code. Six of the seven gaps below are small
additions to working machinery, not new subsystems.

### 1.1 The desktop app enrolls the device

`apps/desktop` is a Tauri 2 shell (Rust in `src-tauri/`, React 19 in `src/`)
that ships `oxagen` and `tacho` as bundled sidecar binaries. It links both CLIs
onto `PATH`, signs the machine in over the CLI's browser PKCE loopback flow,
enrolls the host against a workspace, and adds or drops a wrapper per harness.
It owns no state of its own. Every panel reads files the CLIs write.

### 1.2 The device has a key

`packages/tacho/src/host/device-key.ts` holds an Ed25519 private key at
`~/.config/oxagen/tacho/device.key` (PKCS#8 PEM, mode 0600).
`~/.config/oxagen/tacho/host.json` carries `device_key_fingerprint` and
`device_public_key`. `tacho reassign` keeps the key so the Fleet page sees one
continuous host across a reassignment.

This is the oxagen-arp pack's `DeviceEnrollment` record, already working.

### 1.3 `tachod` is a real OS service

`packages/tacho/src/host/service.ts` renders the unit files and `tacho enroll`
installs them:

| Platform | Mechanism | Identity |
|---|---|---|
| macOS | launchd agent | `sh.oxagen.tachod` |
| Linux | systemd user unit | the enrolling user |
| Windows | Task Scheduler task | `OxagenTachod` |

Service manager calls sit behind an `Exec` port, and the daemon itself uses an
`ExecAsync` port so a synchronous spawn cannot block a hook answer.

### 1.4 The control inbox already applies commands

`packages/tacho/src/collector/inbox.ts` (264 lines) is the seam this document
extends. It accepts eight commands:

| Command | Scope | What it does today |
|---|---|---|
| `pause` | session | sets `record.control.paused`, acknowledges `applied` |
| `resume` | session | clears `record.control.paused`, acknowledges `applied` |
| `cancel` | session | sets `control.cancelled`, sends `SIGTERM`, acknowledges `applied` |
| `kill` | session | sets `control.cancelled`, sends `SIGKILL`, acknowledges `applied` |
| `message` | session | queues text for the next hook boundary, acknowledges `received` |
| `steer` | session | same as `message` |
| `refresh_bundle` | host | refetches the policy bundle |
| `revoke` | host | suspends the host |

A command with no `session_uuid` fans out across `deps.registry.live()` on that
host. The acknowledgement vocabulary is closed: `applied` with the `seq` that
recorded it, `received` for text queued for the next boundary, `expired` for a
command already past its deadline on arrival, and `failed` with a reason.

### 1.5 Steering already reaches the agent

ADR-091 put `bundle.context.system` on the policy bundle every enrolled host
fetches. The collector hands it to Claude Code at `SessionStart` and after
`compact` as `additionalContext`, and chains its digest into the run.

### 1.6 The gateway is built, and its gaps are specified elsewhere

`docs/specs/gateway/spec.md` covers the loopback model proxy, observed
metering, the enforced session budget, the in flight interrupt, and gaps G1 to
G5. Do not re specify any of it here. S7 below points at G1 and G2 and adds
nothing to them.

## 2. What the imported design adds

The oxagen-arp pack specifies a local Supervisor: a protected service that runs
outside the agent's writable privilege boundary, supervises certified harness
sessions, and connects to the model, context, and tool gateways. Its own words,
at `reference/ARP-0.2-technical-reference.md:445`:

> Place the trusted supervisor outside the agent's sandbox. It must retain
> authority if the agent process, repository code, installed packages, MCP
> server or shell is malicious. A library injected into the agent process is not
> that boundary.

The design reaches the same limit ADR-096 does, and states it at line 918:

> The supervisor need not be an administrator on every platform, but its
> security boundary must be stronger than the agent's permissions. Protection
> against the device administrator additionally requires managed devices or
> separately administered runners.

So the pack did not find a way around ADR-096. What it did supply, in more
detail than any oxagen document currently carries, is the protocol for making a
pause, a steer, and a recording mean something. That protocol is §9A and §23A
to §23E, and it is what this spec ports.

### 2.1 A word collides, and the collision matters

Oxagen already uses "steering" for authored governance documents: the proposal,
the Context PR, the six checks, the freshness signal, and the published record
(ADR-061, ADR-091, ADR-097). The pack uses "steering" for a live directive
delivered into a running turn.

They are different mechanisms with one name. Where this document means the live
kind, it says **live steer**. Where it means the authored kind, it says
**steering record**. Do not merge the two code paths.

## 3. The gaps

### 3.1 S1: a pause that confirms

`inbox.ts` sets a flag and reports success:

```ts
case "pause":
  record.control.paused = reasonOf(command);
  events.push(applied(record.recorder, command, "session_paused"));
  return { events, status: "applied" };
```

Nothing checked whether a model request was in flight, whether a tool was
mid dispatch, or whether a subagent kept running. The pack rules this out
directly at §9A:

> An interruption request and a completed interruption are different facts. ARP
> MUST NOT report `paused` merely because a cancellation was sent, an API
> accepted it, a connection closed, a timeout elapsed, or one harness
> acknowledged it.

`cancel` and `kill` carry a sharper version of the same defect. Both
acknowledge `applied` unconditionally, while the `oxagen:kill_attempted` event
beside them records `kill_outcome` as `sent`, `failed`, or `no_pid`. A cancel
whose target had no pid acknowledges success today. Fix that in this build: the
acknowledgement must read the kill outcome.

**Build.** Add the lifecycle `running → pause_requested → pausing → paused →
resuming → running`. `pause` returns a durable acknowledgement and a `pause_id`;
confirmation is a separate event. A failed or timed out confirmation leaves the
run `pausing` with a `pause_unconfirmed` reason and explicit blockers, and
admission stays closed. Surfaces show `pausing`, never a silent `paused`.

Commit a `PauseBoundary` receipt carrying, at minimum: `pause_id`, the issuing
command reference, the participant set, the prior and fenced authority epochs,
the dispatch and result admission fence references, participant acknowledgements
or isolation evidence, the accepted event frontier, request dispositions, and
the confirming event with its `seq`.

Resume requires the confirmed boundary and an expected run revision. It cannot
race ahead of confirmation.

**Honest limit, and put it in the UI copy.** A cancelled network request does
not prove the provider stopped computing or stopped billing. Record a request
that continues upstream as detached with `upstream_stop_unconfirmed`. That
confirms an Oxagen execution pause, not cessation of provider work.

### 3.2 S2: one ordering point

Today a `steer` command and the next model request race, and nothing records
which won. The pack's requirement, §23B:

> every boundary/admission gate MUST synchronize with the authoritative control
> inbox, and submission versus admission MUST have one recorded ordering point.
> If the submission orders first, that admission sees the directive; if
> admission orders first, already admitted work may finish and the next boundary
> applies it.

**Build.** Define the execution boundary as the supervisor controlled end of
the current admitted step: one model request, one tool operation, or one
declared parallel tool batch. A batch's membership is fixed at admission and
cannot grow to postpone a steer.

Every admission gate reads the control inbox before it admits. Record the
ordering. A live steer folds into context at the first boundary after its
submission ordered, before the next step is admitted. If the run is idle, the
boundary is the next admission gate. No new human turn is required.

A non interrupting steer does not cancel admitted work. At the boundary, hold
tool proposals that have not dispatched, compose the directive into the next
model request, and authorize continuation. Proposals built from pre steer
context stay proposals and need fresh authorization.

### 3.3 S3: late replies stay out

Nothing today stops a reply that arrives after a cancel from entering the
transcript. The rule, §9A:

> Any response, stream chunk, callback or completion from an interrupted request
> that was not accepted before the result-admission fence is evidence-only by
> default, even if generated earlier or received after resumption.

**Build.** Persist such a reply as `response.late_observed` with its payload
reference, source, observation time, and exclusion reason, correlated by the
server held run, branch, request, attempt, and epoch mapping. Deduplicate
repeat delivery. Flag conflicting content for one response identity.

Late material must not enter the resumed transcript, the model input, memory,
any retrieval index the agent can read, the tool dispatcher, or the
continuation state. Partial output already shown stays historical output marked
interrupted. Late chunks do not quietly finish it.

Late receipts may still settle billing and update the effect ledger. Never
discard evidence that an external write succeeded; it can block an unsafe
retry.

Reuse requires a separate `response.adopt` decision by an authorized principal,
naming the evidence, the destination turn, the purpose, and the transformed
content digest. Receipt arrival never authorizes adoption. An adopted tool
proposal still needs fresh action authorization.

### 3.4 S4: a receipt that names the request

`inbox.ts` acknowledges `received` when it queues steer text and the injecting
hook later acknowledges `applied`. Neither says which request carried it. The
pack's constraint, §23B:

> `Applied` identifies the actual context/request digest that contains the
> steering, not a claim that the model obeyed it.

**Build.** The `applied` acknowledgement carries the digest of the assembled
request that contains the text. Keep the disclaimer in the surface copy: applied
means the text was in the request, not that the model followed it.

### 3.5 S5: a durable fleet operation

Host level fan out loops `deps.registry.live()` on one machine. One steer across
a workspace needs a durable record. The pack calls it `FleetSteeringOperation`:
an authorized issuer, an immutable target snapshot, the directive, the interrupt
option, a control sequence, and per target progress.

**Build.** Resolve matching enrolled runtimes bound to the workspace's connected
repos, commit one operation with the resolved target set, and deliver at least
once with idempotent per target application.

Per target status: `accepted`, `delivered`, `queued`, `boundary_reached`, and
`applied`, plus `offline`, `blocked`, `expired`, and `ended_without_application`.
A run that finished before application reports `ended_without_application`, not
success. Offline and stale registrations stay in the receipt with their real
status.

Two rules the UI must hold. Sessions started after the snapshot do not silently
join a one time broadcast; a standing workspace directive is a separate thing.
And the surface never reports applied to all while one target lacks a receipt.

This needs the four remaining pack records alongside `DeviceEnrollment` (§1.2):
`CheckoutBinding` (workspace, stable repository identity, approved checkout
root, trusted filesystem identity), `RuntimeRegistration` (operator, agent,
runtime, adapter version, checkout binding, active runs, advertised control and
capture capabilities), and `PresenceLease` (last contact, sync cursor, effective
revisions, lease expiry, online or stale or offline).

A mutable Git remote URL is supporting evidence, not authoritative enrollment.

### 3.6 S6: a recording that names its gaps

A session recorded at hook fidelity and a session recorded at proxy fidelity
look alike on the surface today. Gateway G5 covers detecting the unrouted
session. This gap is the neighbouring one: what a complete recording contains,
and what happens when capture fails.

The pack's artifact set, §23D. Retain each separately:

1. the cleaned user prompt,
2. the cleaned ordered request after harness instructions, steering, memory, and compaction,
3. the sanitized provider payload,
4. the inspected model reply,
5. safe views of proposed and of executed tool arguments, kept apart,
6. cleaned tool and API results,
7. the transformed output the model consumed.

Attribute each to org, workspace, checkout, device, operator, agent, runtime,
run, branch, turn, request attempt, and tool call. Preserve stream ordering,
errors, latency, denials, usage, and cost. Record explicit gap, redaction,
truncation, and unavailable markers rather than leaving a hole.

**The enforceable part.** Two sentences carry the weight:

> An adapter must prove coverage for model traffic, tools, children and
> background activity before displaying full-capture assurance. Observability
> samples alone do not establish completeness.

and

> Unrecoverable capture failure stops further governed dispatch under the strict
> profile.

**Build.** A `capture_coverage` claim per adapter, per harness version, stating
which of the seven artifacts it can produce. The surface shows the claim, not a
generic "recorded". Under a strict workspace profile, unrecoverable capture
failure closes admission.

**Honest limit.** Provider added prompts and private model reasoning are not
observable, so they are not part of a completeness claim. Say so where the claim
appears.

### 3.7 S7: the boundary itself

A launchd agent, a systemd user unit, and a per user scheduled task all run as
the same user as Claude Code. Today the agent can stop `tachod`, rewrite
`host.json`, or unset the base URL. Nothing above S7 is enforceable against the
person at the keyboard until this changes, which is what ADR-095 means by the
`harness` tier never claiming enforced.

This gap is `docs/specs/gateway/spec.md` G1 (the confining launcher) and G2
(base URL integrity). Build them there, not here. Two additions this document
asks for:

1. **Separate the service identity from the agent's.** The pack splits
   `DesktopUI` from `DesktopGatewayService` and states at line 141 that "the app
   window is not this security boundary". Where the platform allows a system
   scoped service or a managed configuration, enrollment writes there.
2. **Record what the platform could not do.** The pack keeps a
   `platform_attestations` record with a challenge, a pass, fail, or unknown
   result, a coverage artifact, and a verifier. Per its `ARP-Desktop-app-spec.md`
   line 11: a setup that cannot block bypasses must say so and cannot launch
   strict work.

## 4. What is not here

- **The ScanReceipt and local redaction before egress.** The pack has the local
  gateway rewrite the request, sign a receipt binding the cleaned digest, and
  have the org proxy verify it. It is a good answer to G2, and it changes what
  Oxagen sees. ADR-094 decided that prompt bodies go to the vendor and not to
  Oxagen. Reopening that is an ADR that supersedes ADR-094, not a line in this
  spec.
- **OPA and Rego as the policy engine.** The pack selects them. Oxagen has not
  decided, and this document does not need the decision.
- **Budget leases and offline escrow.** Worth taking from §23D, on its own
  track, with `docs/specs/model-funding-source/spec.md`.
- **microVM or gVisor isolation.** A Phase 5 platform choice under ADR-096.
- **Hosting the turn loop.** ADR-043 stands. The pack agrees with it: "Framework
  and SDK cooperation alone do not create enforcement"
  (`reference/ARP-0.2-technical-reference.md:843`).

## 5. Build order and acceptance

| Order | Gap | Done when |
|---|---|---|
| 1 | S1 confirmed pause | A pause with an in flight model request reports `pausing`, not `paused`, until the boundary commits. A `cancel` whose target has no pid acknowledges `failed`, not `applied`. A `PauseBoundary` receipt exists for every `paused` run, and `resume` refuses without one. |
| 2 | S4 request digest on the receipt | Every `applied` acknowledgement for a live steer names the digest of the request that carried the text, and a test asserts the digest matches the assembled request. |
| 3 | S2 one ordering point | A steer submitted while a model request is in flight is recorded as ordering before or after that admission, and the next boundary applies it. A test races the two and asserts no step bypasses a pending steer. |
| 4 | S3 late reply exclusion | A reply arriving after the fence is persisted as `response.late_observed` and is absent from the resumed transcript, model input, and tool dispatcher. Adoption requires an explicit `response.adopt` event. |
| 5 | S6 capture coverage | Each adapter publishes a `capture_coverage` claim. A session missing an artifact class shows the gap rather than a generic recorded state. Under a strict profile, capture failure closes admission, with a test. |
| 6 | S5 fleet operation | One workspace steer reaches several devices, each run emits a receipt naming its request digest, another workspace receives nothing, and idle, ended, and offline targets report their real status. |
| 7 | S7 the boundary | Tracked as gateway G1 and G2. Until both land, every surface reading these claims carries the ADR-095 scope phrase. |

S1 and S4 come first because both are small, both correct a claim the product
makes today that the record cannot back, and neither depends on the launcher.
S5 is last of the six because it is the only one that needs new control plane
tables.

### 5.1 Acceptance tests to port

The pack's §23E gates 1, 2, and 4 apply directly. Write them as integration
tests, not as a checklist:

1. One owner submits a workspace broadcast to several devices. Each targeted run
   emits an application receipt naming the exact request. Another workspace
   receives nothing. Idle, ended, and offline targets report accurately.
2. Race a non interrupting submission against a model completion, a parallel
   tool batch completion, and the next dispatch. Recorded control ordering
   decides the eligible boundary. No next step bypasses a pending steer.
   Interruption excludes late results.
3. Compare known prompt and tool byte fixtures against expected cleaned and
   consumed artifacts, including long outputs, failures, compaction, children,
   and delayed streams. Prove strict dispatch fails when durable capture is
   unavailable.
