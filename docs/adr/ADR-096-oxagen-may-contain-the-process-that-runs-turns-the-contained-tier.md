# ADR-096: Oxagen may contain the process that runs turns: the contained tier

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** platform
- **Decided by:** the maintainer, 2026-09-18, approving the architecture review
  of the same date in full
- **Related:** ADR-043 (runtime excision; amended by one sentence), ADR-064 (the
  witness runner; amended), ADR-007 and ADR-011 (the retired sandbox drivers),
  ADR-076 (`sandbox_required` on a general run's spec), ADR-094 (the gateway),
  ADR-095 (the ladder)
- **Delivered by:** Phase 5, last in the build order (Phase 0 in review, Phase 4
  in build, then Phases 1, 2, 3, 5)

## Context

Checked at `main` `02278c913`.

- No sandbox remains after ADR-043. There is no filesystem, network or egress
  containment anywhere in the tree.
- Wrapping is file edits plus a daemon. No Oxagen command launches an agent.
  `apps/cli/src/commands/run.ts` holds `oxagen run export <run-id>` and nothing
  else.
- The witness runner of ADR-064 is not built. `rg -i "witness.?runner"` finds
  no code, only the ADR, the spec and the proof tables.
- Everything at the `harness` and `gateway` tiers can be removed by the person
  who owns the machine (ADR-094, ADR-095).

On a laptop the developer owns, nothing is enforceable against the owner. A
mandatory sandbox there buys friction, not security: toolchains, SSH keys,
Docker and local services all break. Enforcement means something where the
operator is not the machine owner: managed devices, CI, cloud runners and
headless fleets. That is also where unattended risk lives.

## Decision

**Sandbox is the top tier, not the only tier. Hooks stay.**

`oxagen run -- <agent>` is a supervisor that launches the agent under an OS
sandbox with egress limited to the gateway, the hook configuration pinned
read-only, and a filesystem policy. It is aimed at CI, headless runs,
cloud runners and managed devices first, and is never mandatory on a developer's
own laptop. The witness runner (ADR-064) is built on the same launcher.

ADR-043 is revised by one sentence:

> **"Oxagen does not run turns, but it may contain the process that does. A
> launcher that confines a process is not an agent runtime."**

Inside the contained tier the only allowed egress is the gateway. That rule
alone turns the two network seams (model traffic, MCP traffic) from attested to
enforced, because no process in the sandbox can reach a model or a tool server
any other way. It does nothing for the hook seam. The harness's built-in tools
(Bash, Edit, Write) run inside the sandbox, and a process inside the sandbox
can edit the settings file that installs the hooks, set `disableAllHooks`, or
start a second copy of the harness without them. Gateway-only egress leaves
those actions as client-attested as they are at `harness`.

So `contained` requires three controls, and the launcher attests to each:

1. **Gateway-only egress.** Every model and MCP request from every process in
   the sandbox goes through the gateway or fails.
2. **A filesystem policy.** The writable set is the workspace the launcher was
   given. The harness's settings file, its hook entries, and the `tacho-hook`
   binary are read-only inside the sandbox.
3. **Hook integrity at launch.** The launcher starts the binary it chose with
   the hook entries it wrote, records a digest of that configuration, and the
   sandbox denies writes to it for the life of the run.

With all three, "enforced" covers the two network seams and the filesystem
boundary against the machine's operator, and the hooks that refuse local tool
actions inside the writable set cannot be removed without escaping the sandbox.
A run whose attestation lacks any of the three is not `contained`. It earns
whatever its routed traffic earns, `gateway` at most. `contained` becomes the
top word of the ladder (ADR-095) and the only one that earns "enforced" against
the machine's operator.

## What the launcher is, and is not

- It starts a process the customer chose, under confinement, and records that it
  did. It assembles no prompt, calls no model, picks no tool and holds no vendor
  credential.
- It is not the sandbox ADR-007 and ADR-011 described. Those ran Oxagen's own
  agent's code. This confines someone else's agent.
- `oxagen run -- <agent>` shares a verb with `oxagen run export`. The `--` form
  is the launcher and the subcommand form stays. Phase 5 must keep both parsing.

## Consequences

- `contained` is computed like every other tier: a launcher attestation on the
  run naming all three controls, plus gateway-only egress shown by the record.
  A run started outside the launcher on the same machine is not contained, and
  neither is a run whose attestation lacks a control.
- The witness runner stops being a separate execution plane to design. It is the
  launcher with a proof workload.
- The OS mechanism (per platform) is a Phase 5 build choice and is not decided
  here. Linux CI runners come first, because that is where the first target
  population runs.
- `docs/VISION.md` lists "sandbox" under running agents as drift. It gains the
  same one-sentence distinction, so the vision gate does not flag Phase 5.
- ADR-076's `sandbox_required` field keeps its meaning for a run's spec and is
  not the contained tier. A later ADR may join them. This one does not.

## Supersedes and amends

- Amends ADR-043 by the one sentence above. Everything else in ADR-043 stands:
  Oxagen still runs no turn.
- Amends ADR-064: the witness runner is built on the Phase 5 launcher.
- Amends ADR-078 §1 through ADR-095: a fourth tier value.

## Alternatives considered

**Sandbox only.** Rejected. With zero customers and a population of Claude Code
and Codex on laptops, a sandbox-first product stops adoption at the first
install, and it enforces nothing against a machine's owner anyway.

**Remove hooks and rely on the sandbox.** Rejected. Hooks are the tier a laptop
needs, they see the harness's built-in tools, and they are already built.

**Never contain a process, to keep ADR-043 untouched.** Rejected. Then no tier
ever earns "enforced" against an operator, and a control plane whose every
control is advisory is a dashboard.

**A cloud-hosted runner as the only contained option.** Rejected for the same
reason as the cloud proxy in ADR-094: custody of source code and credentials.
A customer's own CI runner is the first target.
