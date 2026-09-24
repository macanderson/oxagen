# ADR-160: An agent's day is a UTC calendar day

- **Status:** Proposed
- **Date:** 2026-09-24
- **Owners:** platform
- **Related:** ADR-094 (the gateway), ADR-149 (independent model policy),
  #3728 (the per-day budget refuses nothing), #3710 (the per-run budget),
  #3759 (the published definition budget)

## Context

An agent definition can carry two ceilings: `per_run_micros` and
`per_day_micros`. The loopback model proxy refuses a call once a session's
observed spend reaches the per-run figure (`session_budget_exceeded`). Nothing
refuses against the per-day figure. #3728 found that the control plane signed
it into the mandate as `daily_limit_usd` anyway, and a later change stopped
signing it, so today an operator who sets only a per-day budget gets a mandate
that reads `observed`.

Enforcing it needs two things the session budget never needed:

1. A rule for what a day is, which a host asleep across midnight, a host in
   another timezone, and an auditor reading the record afterwards all apply
   the same way.
2. A day's spend for the agent that spans its sessions and its hosts and
   survives a daemon restart. The session counter reads one session's chain
   once and adds to it in memory, so it provides neither.

## Decision

### A day

**A day is a UTC calendar day, 00:00:00 to 23:59:59.999 UTC. A model call
counts toward the day in the timestamp of the frame that records it.**

That is the whole rule, and it is the one AWS Budgets, Azure Cost Management,
the OpenAI and Anthropic usage consoles, and Snowflake resource monitors use.
It survives an audit for three reasons:

- **One clock for everyone.** The host, the control plane, and an auditor
  replaying an export assign every call to the same day from the same field.
  No setting, timezone, or daylight-saving rule changes the answer.
- **The record decides.** The `llm_call` frame's `ts` is sealed into the
  hash chain. A reviewer can recompute any agent's daily total from the
  exported frames alone.
- **Nothing is configurable.** A per-workspace or per-host timezone would
  let two people read two different totals for the same day off one record.

A session that runs across midnight UTC charges its calls before midnight to
the first day and its calls after midnight to the second. A host asleep
across midnight wakes into a new day with that day's spend, which is whatever
the agent has already spent on other hosts since 00:00 UTC. A host in UTC-7
sees its day turn at 17:00 local time. The agent editor says so next to the
field.

The session budget is unchanged. A session is still one run, whatever days it
spans.

### A day's spend

An agent's spend for a day is every observed, priced model call recorded for
that agent with a frame timestamp in that day, on every host enrolled under
it. The proxy computes it as:

```
day spend = this host's calls today, read from its own WAL
          + the control plane's total for the agent's other hosts today
          + calls this proxy has priced since it last read either
```

- **This host's share comes from its WAL.** The WAL keeps every frame for
  seven days (`walRetainMs`), shipped or not, so a daemon that restarts at
  noon reads back its morning. The control plane also returns this host's
  shipped total, and the proxy takes the larger of the two, so a host whose
  WAL was wiped still counts what it already shipped.
- **Other hosts' share comes from the control plane.** It is the one party
  that sees every host of the agent. It returns their total with the day it
  was computed for, and the proxy ignores a total for a day that is not
  today.
- **The proxy adds as it prices.** Every priced call adds its cost to the
  running day total, the same way it adds to the session total. When the UTC
  day turns, the running total starts again from the new day's seed.

Two reads of the record, WAL and control plane, never count the same call
twice: the control plane's other-host figure excludes this host by its
enrollment id.

### Where the numbers arrive

The host's own share needs nothing new: the proxy reads the WAL the daemon
already keeps (`priorDaySpendMicros` in `collector/daemon.ts`). It reads only
sessions whose last frame is from the day in question, so a week of retained
frames is not parsed on every restart.

The control plane's figures ride the control envelope, as
`agent_day_spend: { day, this_host_usd_micros, other_hosts_usd_micros }`.
The envelope arrives on every ingest batch and command poll, so the figure is
never older than the host's poll interval. It is unsigned on purpose: it is
a reading of the record, not a decision, and the ceiling it is compared with
is the signed one. The host parser drops a figure it cannot read and keeps
the rest of the envelope.

`controlEnvelope` (`packages/handlers/src/lib/tacho-host.ts`) computes it only
for a host whose bundle carries `daily_limit_usd`, so a host with no daily
ceiling costs no read. It lists every host enrolled under the agent, whatever
its status now, because a host revoked at noon still spent its morning. It
then sums ClickHouse `tacho_events` (`selectAgentDaySpend` in
`packages/telemetry`) for those hosts:

- `kind = 'llm_call'`, `source = 'collector'`, `fidelity = 'proxy'`, and
  `oxagen.metering = observed`. These are the calls ingest counts as observed
  usage, and the only calls the proxy prices.
- `ts` in the UTC day. This is the frame's own timestamp, not `received_at`,
  so a frame shipped after midnight counts toward the day it was recorded in.
- `FINAL`, so a redelivered frame counts once.

A day's total is therefore reproducible from `tacho_events` with one query,
and from an export with no query at all.

The organisation and workspace spend counters (`billing.spend_counters`) are
a separate ledger. They bucket by the day a frame was received and carry no
agent, and this record does not change them.

### The ceiling and the refusal

The control plane signs `per_day_micros` into the bundle as
`budget.daily_limit_usd` again, and sets `budget.mode` to `enforced` when the
agent declares either ceiling. It does so only for a host that advertises the
`daily_budget` bundle feature. An older host gets no daily ceiling, because it
would carry the figure and refuse nothing, which is the defect #3728 reported.

`refusalFor` checks the daily ceiling after the session ceiling. A call is
refused with `daily_budget_exceeded` when the agent's day spend has reached
`daily_limit_usd`. The message names the observed spend, the ceiling, the UTC
day, and the time the day resets:

```
This agent reached its Oxagen daily budget: $5.02 observed of a $5.00 limit on 2026-09-24 (UTC). It resets at 2026-09-25T00:00:00.000Z. Ask the workspace's operator to raise the limit.
```

The refusal applies to every call on the host once the day's spend is at the
limit, attributed to a session or not, because the ceiling belongs to the
agent and not to a session.

### What fails open and what fails closed

The proxy's existing rule holds: a fault of Oxagen's never stops a call, and
a decision of the operator's always does.

- **The control plane is unreachable.** The proxy counts this host's WAL and
  the last other-host total it received for today, and zero for other hosts
  if it has none. The host keeps its own ceiling exactly. It may miss spend
  on other hosts until the control plane answers again.
- **A model has no price.** The call costs the day budget nothing and its
  frame says `observed_unpriced`, as it already does for the session budget.
- **The host clock is wrong.** The host assigns the day from its own clock,
  because that is the clock that stamps the frame. A host whose clock is a day
  off reads the wrong day's ceiling, and its frames carry that same wrong
  timestamp, so the record shows exactly what the proxy did.

## Alternatives rejected

- **The workspace's or the operator's timezone.** Easier to read on a
  dashboard, and it gives two hosts of one agent different days, needs a
  daylight-saving table on the host, and makes a 23-hour and a 25-hour day
  every year. A later dashboard can present UTC days in local time without
  changing what a day is.
- **The host's local calendar day.** A laptop that flies from New York to
  Tokyo would get a second day's allowance on landing.
- **A rolling 24-hour window.** Nobody can say when it resets, and the answer
  changes with every call.
- **Seed the whole total from the control plane.** Ingest lags the proxy by
  the shipper's interval, so a host would under-count its own calls between
  shipments. The WAL already holds them.
- **Stop offering a per-day budget on wrapped agents.** Honest, and it
  removes a control operators asked for. It stays the fallback if this build
  does not ship.

## Consequences

- An operator sets the per-day budget in the agent editor, beside the per-run
  budget, and the field's hint says the day is UTC. It writes
  `budget.per_day_micros` into the definition, as the per-run field writes
  `per_run_micros`.
- An operator's per-day budget refuses on every host that advertises
  `daily_budget`.
- A per-day budget on an agent whose hosts are all older than this build
  still signs nothing, and the editor's hint says so.
- The daily total a host enforces can trail the true total by what other hosts
  spent since the last control poll, plus what they have not yet shipped. The
  poll and ship intervals bound that lag. A single-host agent has no lag.
- Every control poll for a host with a daily ceiling costs one ClickHouse
  aggregate over one day of one workspace's frames, bounded by the
  `toYYYYMM(ts)` partition.
- `packages/tacho/README.md` lists `daily_budget_exceeded` with the other
  refusals.
