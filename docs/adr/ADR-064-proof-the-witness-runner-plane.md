# ADR-064: Proof: the witness runner plane

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Related:** issue #2955 (proof: witness runs, the flip, verdicts, proven
  spend), ADR-043 (Oxagen governs agents and does not run them; this ADR names
  the one execution plane it operates), ADR-042 (organisation data planes),
  ADR-058 (the run record the verdict lands on), ADR-060 (the rollup that
  carries the run's verdict), Mission Control spec §8.2, §8.5, §12.8,
  App. A.7, `packages/run-evidence/src/proof.ts`,
  `packages/database/atlas/migrations/20260915205000_proof_witnesses_verdicts.sql`

## Context

A run is proven when a witness, a check the worker never sees, fails on the
pull request's target and passes on its head (spec §8.5). The spec states
three invariants: the flip is measured against the target, the worker never
sees the witness or its environment, and only pass or fail comes back unless
a human raises the disclosure grain. It also says the witness runner is "the
one execution plane Oxagen operates", which reads against ADR-043's rule that
Oxagen runs no agent.

Before #2955 the tree held no witness or verdict store, the `verdict`,
`accepted` and `productive_ratio` columns on `cost.run_totals` stayed null,
and Spend's proven figure had no writer. The issue left three decisions to
the maintainer, each with a recommendation. This ADR adopts the three
recommendations and records the choices the build made under them.

## Decision

### 1. The witness runner is an Oxagen-operated plane, separate from every worker

The runner is one service under `infra/`, ephemeral per witness run, with its
own KMS key and its own credentials, no network path from any worker's run,
and no filesystem a worker reaches. For an organisation on a dedicated data
plane (ADR-042) it runs inside that plane. It runs witnesses and nothing else:
its only model access is the author call. ADR-043 stands for agents; this is
the named exception for witnesses, and no other execution plane may cite it.

The maintainer approved the plane on 2026-09-15 with an AWS budget cap of
$200 a month. Building the infrastructure is a separate lane; the authoring
lane (decision 2) is the first code that dispatches to it.

### 2. Verdicts are ingested first; authoring is a second lane

This revision accepts `proof.observed` frames a producer puts on the worker's
chain (Stella's local ladder today, the runner once it exists) and records
them. `author_witness` and `run_witness` are a separate lane; both use the
same frame.

- **The body has one schema.** `proofObservedBodySchema` in
  `@oxagen/run-evidence` is the §8.5 JSON body plus two additive fields:
  `tamper` (the authored and at-run fingerprints, present exactly when the
  exclusion broke) and `held_out`. It refuses a `flipped` body without a fail
  on the target, a pass on the head and a held fingerprint, and a broken
  fingerprint under any verdict but `tampered`. The command text, test names
  and witness paths are not fields: only digests travel.
- **The frame rides the tacho chain.** `proof.observed` is a `tacho/1.0` kind.
  The leaf `@oxagen/tacho` package carries the body opaquely; the
  `ingest_tacho_events` contract validates it against the run-evidence schema,
  so a malformed proof body refuses the batch at the kernel's input parse.
- **Ingest writes the record.** Each fresh `proof.observed` frame writes one
  `evidence.verdicts` row (attempt number in frame order per run and witness)
  and, on first sight, one `evidence.witnesses` row. A witness's oracle kind,
  command digest and held-out flag are immutable: a frame that names a known
  witness with different ones refuses the batch with `conflict`
  (`witness_identity_changed`). A re-sent frame writes nothing. A frame on a
  subagent's chain is recorded under its root session's run, the run
  `list_runs`, `get_run` and the rollup know; the row names the session whose
  chain carried the frame, since each chain numbers its frames from 0.
- **The run's verdict is aggregated, once, in one function.**
  `aggregateRunVerdict` takes each witness's latest attempt and returns the
  highest-ranked word: `tampered`, `failing`, `unsatisfied`, `unverified`,
  `unmoved`, `flipped`, `waived`. A run is `flipped` only when every witness
  flipped; held-out witnesses count. The cost rollup writes the result onto
  `cost.run_totals.verdict` whenever it rebuilds the run, and ingest asks for a
  rebuild when a proof arrives for a run already sealed. Spend's proven figure
  (ADR-060) counts only `flipped` runs, so a `tampered` run credits nothing.
- **A witness run is its own run.** The frame's `witness_run_id` names it;
  the rollup attributes its cost to the worker run's operator, and `get_run`
  answers `witnessFor` on it. Because both act on the link, ingest refuses
  one that names the run itself, a run outside the workspace or not a root
  run, a run with verdicts of its own, or a run another run's verdict
  already names, and refuses a verdict on a run that is itself a witness run
  (`conflict`, `witness_run_invalid`).
- **Trust is the chain's.** An ingested verdict is as attested as the chain
  it arrives on (§8.3): a client-attested chain attests receipt and integrity,
  not the truth of the content. The runner attestation is stored with the row
  and sealed with the frame; verifying it against a published runner key
  arrives with the runner plane.
- **`accepted` has no writer yet.** No recorder captures a human verifying an
  outcome without a witness, so `list_runs` and `get_run` carry `verdict` and
  not `accepted` until one does.

### 3. Disclosure grain: `L0` by default, changed only by a person

The workspace's grain is a row in `evidence.disclosure_policies`; no row is
`L0`. `set_disclosure_grain` changes it: an org Owner or Admin in a signed-in
session, recorded as `evidence.disclosure_grain_changed`. The proof record is
readable the same way: `get_run_proof` answers only a signed-in member and
refuses any API-key caller (`session_required`), because a worker holds API
keys and the record names which witness failed and which were held out. A
witness run is fenced from API keys the same way: `list_runs` leaves witness
runs out for an API-key caller, and every run read that resolves a run by id
(`get_run`, its transcript, frame bodies, bisect, export, fork, summarize)
answers `not_found` for one. For
the same reason neither capability has an MCP tool: MCP is the surface agents
connect to, and its context carries no signed-in user.

## Consequences

- The Run page's Proof tab, the witness run's tab set, Fleet's verdict column
  and Spend's proven split all read contracts that exist.
- A run with no witness answers `verdict: null`; nothing fabricates `none`
  on read.
- `witness_probe` incidents, the task reference and the expected fail mode
  on a witness, and the witness lifecycle status have no producer in this
  revision; they arrive with the authoring lane and the tool gateway policy
  that denies a probe.
- The runner plane is approved under a $200-a-month AWS budget cap; its
  infrastructure is built in its own lane.
