# ADR-163: Operator controls do not depend on the policy tier

- **Status:** Accepted
- **Date:** 2026-09-23
- **Owners:** platform
- **Related:** ADR-056 (run commands), ADR-094 (the gateway), ADR-095
  (enforcement tiers), ADR-141 (where a Cursor steer lands), #4023

## Context

`dispatch_command` queues pause, resume, cancel and steer for a wrapped run.
The host carries each command: its daemon polls `fetch_commands`, and the hook
adapter applies what it receives.

Until #4023 the handler refused every command to a run whose enforcement tier
was `observe`, with `observe_tier`. The tier says where Oxagen saw the run's
actions and whether a policy verdict was enforced there. It says nothing about
whether a command can reach the run. An observe-tier run on a host that polls
every two seconds took pause and cancel as well as any other. The operator
still could not stop their own agent.

The same handler accepted commands no host would take. A session with no
enrolled host, a revoked host, or a host asleep for an hour queued a command
that nothing collected. The run page showed live controls on runs like that.

Steering had the same gap. The form offered `next_step` and `interrupt`, and
the command recorded them, but the hook adapter delivers steering text only at
the next prompt. The mode on the record promised an arrival time the host did
not keep.

## Decision

**A command reaches a run through its host's command poll, whatever the run's
enforcement tier.** The tier governs policy verdicts. It never decides whether
an operator can pause, resume, cancel or steer.

`commandBlockOf` in `packages/oxagen/src/contracts/run.list.ts` is the one
rule for whether a command can reach a wrapped run. It returns the reason a
command cannot, or null when it can:

| Reason | Meaning |
|---|---|
| `run_sealed` | The session recorded an end. A session the control plane closed for idleness (`idle_timeout`) is not sealed for this purpose, because its host may still be running it. |
| `no_host` | The session names no enrolled host. |
| `host_revoked` | The host's enrollment was revoked, so its polls are refused. |
| `host_offline` | The host has not polled in `HOST_POLL_WINDOW_MS`, five minutes. |

`dispatch_command` refuses a directly addressed run with that reason, and
records it as `failed` on a broadcast. `list_runs` and `get_run` return it on
every row as `commandBlock`. The app draws the controls disabled with the
reason, so the page never offers a command the handler refuses.

**A steer records only a delivery mode the host can carry.** A host that
advertises the `steer_next_step` bundle feature has a carrier for the next
model call. Without it, `next_step` and `interrupt` are recorded as
`turn_boundary` with `degraded_reason = no_step_carrier`. With it, `interrupt`
still needs the run's model traffic on the host's loopback proxy (`gateway` or
`contained`), and lands as `next_step` (`harness_tier`) elsewhere. The command
records the requested mode and the one it will get.

## Alternatives rejected

- **Keep the tier refusal and explain it.** The refusal protects nothing. A
  pause or cancel on an observe-tier run does what it does on any other run,
  and the operator is left with no way to stop an agent they can watch.
- **Let the host refuse what it cannot carry.** The command would sit queued
  until it expired, and the operator would learn nothing until then. The
  control plane already knows when the host last polled and what it
  advertises, so it can answer at dispatch.
- **Poll window from the backoff ceiling.** The daemon backs off to 60
  seconds, or 15 minutes on a protocol mismatch. A 15-minute window would keep
  a sleeping laptop's runs looking reachable. Five minutes is several missed
  polls of a healthy host.

## Consequences

- An observe-tier run on a live host takes every command. The pg integration
  test that expected `observe_tier` now expects the command to queue.
- A host that stops polling makes its runs read unreachable within five
  minutes, and the controls say why.
- `next_step` and `interrupt` start meaning what they say as hosts ship the
  `steer_next_step` carrier. Until a host advertises it, every steer lands at
  the turn boundary and the record says so.
- A run that is still `live` after its host stopped reporting keeps that
  status until the idle sweep closes it (#3987). Its controls are already
  disabled by `host_offline`.
