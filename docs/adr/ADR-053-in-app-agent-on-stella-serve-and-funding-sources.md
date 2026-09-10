# ADR-053: The in-app agent runs on Stella's headless engine, and a token is billed only when Oxagen paid for it

- **Status:** Accepted
- **Date:** 2026-09-09
- **Owners:** platform
- **Related:** ADR-043 (runtime excision — Decision 2 and the "keep the
  sidecar" alternative are superseded here; every other clause stands),
  ADR-052 (governed action as the billable unit — amended for one case),
  ADR-042 (organisation data planes — the envelope pattern the customer key
  reuses), ADR-050 (secret access in the main audit log), ADR-033 (the
  Rust engine as agent core — Option B is what this ADR adopts),
  `macanderson/stella` `docs/spec/serve-surface.md` (the engine side),
  `packages/agent/src/runtime/governed-turn.ts` (the loop this replaces),
  `packages/ai/src/models.ts` (the model seam)

## Context

ADR-043 cut the agent runtime and kept one conversational surface, "a thin
in-process governed turn loop" over the AI SDK, on the reasoning that a
governance Q&A agent needs no engine. Two things have changed since it was
written, one day ago.

**The in-app agent has real jobs.** It answers questions about the agents
running in a workspace, which is the Q&A ADR-043 planned for. It also
authors rules that create relationships in the knowledge graph between
nodes sourced from several connectors, and it drives the schema builder.
Those are multi-step tool-using tasks with a budget, a loop to detect,
and an outcome to verify. Rebuilding that loop in TypeScript is how
`agent-engine` came to exist, diverged from Stella, and was deleted last
week. Stella already has the loop.

**The objection to the sidecar was about serverless, and Oxagen is not
serverless.** ADR-043 rejected embedding Stella because "a Rust engine
supervised from a serverless function was an ops burden". The platform
left Vercel on 2026-08-21 and runs as containers on one node. The engine
binary is built to run containerized beside them.

There is also a funding question the code answers by accident. Every
model call reads one key from the process environment. There is no way
for a customer to bring a key, and the platform key's balance on
2026-09-09 was under ten dollars. ADR-052 names BYOK as a design
constraint and then says tokens are never billed, which is right for a
token Oxagen never paid and wrong for one it did.

## Decision

### 1. The in-app agent is a turn on `stella-serve`, reached over HTTP

The engine runs as its own container on the node. Oxagen opens a session,
posts a turn, and reads the event stream. The engine never calls a model
and never runs a tool: each completion and each tool call comes back to
Oxagen as a reverse request, and Oxagen answers it.

- **A tool call is answered through `kernel.invoke()`.** It passes the IAM,
  entitlement, approval and billing gates like every other call, and it
  writes an audit record. Under ADR-052 each one is a governed action and
  bills as one. The engine sees a tool result, never a credential.
- **A completion is answered through `@oxagen/ai`.** The key stays in
  Oxagen. The engine sees text.
- **The engine holds no authority.** Its only configuration is a bearer
  token and the tool surface `remote`, which is the only value the binary
  accepts. Persistence is Oxagen's: the turn's checkpoint and its events
  land in the run ledger, so a turn is replayable from Oxagen's record.

This supersedes ADR-043 Decision 2's sentence "Stella is not embedded as a
sidecar" and its alternative "keep the Stella sidecar". The rest of
ADR-043 stands: no sandbox in Oxagen, no file system, no browser, no
subagents. Those live on the customer's machine in the Stella CLI. The
in-app agent's tools are capability contracts and nothing else.

### 2. One funding source per organisation, resolved at one seam

An organisation has a **model funding source**:

| Source | Who pays the vendor | What Oxagen bills for tokens |
| --- | --- | --- |
| `customer_key` | the customer, on their own vendor account | nothing |
| `platform` | Oxagen, on its key | usage, under §3 |

A customer key is stored with the envelope pattern ADR-042 built for data
planes: ciphertext, key id and digest, decrypted at call time, and every
read recorded in the main audit log per ADR-050. It is never returned to
a client after it is set. A `test` capability verifies a key against the
vendor before it is saved, and reports the failure text the vendor
returned.

The source is resolved in one place in `@oxagen/ai`, and all three call
paths honour it: streamed replies, structured objects, and embeddings. A
call path that reads the process environment directly is a defect.

A new organisation starts on `platform` with the signup grant it already
receives. Switching to `customer_key` is a settings change, and switching
back is too.

### 3. A token is billed only when Oxagen paid for it

ADR-052 is amended for exactly one case. Its rule, "tokens are reported in
full and billed at zero", governs every token Oxagen did not pay for: a
customer's agents on the customer's keys, and the in-app agent under a
customer key. For the in-app agent under the `platform` source, Oxagen is
the one holding the vendor invoice, and it bills that usage back:

- at the rate card's vendor cost plus a published markup, as its own line
  ("assistant usage"), never folded into the action count;
- under a new ledger reason, `consume_assistant_tokens`. ADR-052 retired
  `consume_token_overage`, and a retired reason is not repurposed, so a
  historical row keeps meaning what it meant;
- capped per organisation. A platform-paid organisation carries an
  assistant spend cap, and a turn that would cross it is refused before it
  starts with a message that names the cap. The pre-turn credit gate
  stays in front of it. The cap exists so one organisation cannot drain
  the platform key, which today funds every organisation at once.

The two rules compose into one sentence a customer can check against
their statements: **you pay for the governance you use, and for the
tokens Oxagen bought on your behalf, and nothing else.**

### 4. The engine is a required service, and its absence is a named error

If the engine container is down, the in-app agent says so — "the
assistant engine is unavailable" — and nothing falls back to an
in-process loop. A silent fallback would be the second copy of the loop
this ADR exists to prevent.

## Alternatives

**Keep the in-process TypeScript loop and grow it.** Rejected. Rule
authoring across sources and the schema builder need a budget, loop
detection, compaction, cancellation at a step boundary, and a replayable
trace. Each of those is a subsystem in Stella. Growing the thin loop
toward them is the path that produced `agent-engine`.

**Give the engine the model key and let it call the vendor.** Rejected. The
key would leave Oxagen, the engine would need the funding-source logic, and
a completion would no longer pass the metering seam. Remoting the
completion costs one hop on the node's loopback and keeps every token
accounted for in one place.

**Bill assistant tokens as governed actions.** Rejected. A completion is
not a gate decision, and counting it as one would put a token-shaped cost
into the action rate, which is the drift ADR-052 forbids.

**Never bill tokens, absorb the platform-key cost.** Rejected. It is the
status quo that emptied the key, and it makes the platform source a
subsidy to whoever prompts most.

## Consequences

- `packages/stella-engine-client` returns, rewritten against the current
  serve wire rather than restored from the commit ADR-043 names. The
  restore is the starting point; the wire moved.
- `packages/agent`'s `runGovernedTurn` becomes the reverse-request
  answerer: it keeps the system prompt, the tool materialisation from
  contracts, and the audit, and gives up the step loop.
- `packages/ai` gains a funding-source resolver and loses every direct
  read of the model key outside it.
- `packages/billing` gains the assistant-usage reason, the per-org cap,
  and the cap check in the pre-turn gate.
- An organisation-scoped `model_credentials` table arrives with the
  data-plane envelope columns and RLS.
- A settings page lets an organisation set, test, and clear its key, and
  set its assistant cap.
- The node runs one more container. Its health is part of the deploy's
  health check, and its bearer token is a parameter beside the others.
