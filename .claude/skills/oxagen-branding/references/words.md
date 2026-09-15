# Words

## Use these

The product's vocabulary is Mission Control's vocabulary (spec §3). Use each word exactly as defined and never a synonym.

| Word | Meaning | Not |
|---|---|---|
| run | one session of one agent under one operator, on one task | session, trace, execution, job |
| turn | one prompt through to the point the agent stops | round, iteration |
| step | one model call or one tool call | action event, span |
| frame | one recorded event in a run, hash-chained | log line, event, trace |
| operator | the human accountable for a run | user, owner, initiator |
| agent | a registered principal with one identity | bot, assistant, worker (except in the witness's own text) |
| workspace | a governance partition inside an organization | project, team space |
| governed action | one kernel call Oxagen enforced and audited | invocation, transaction, call |
| dod | the definition of done for a run, as a file and as a frame | acceptance test, spec, checklist, contract |
| check | one entry in a dod: run, file, diff, or human | test, assertion, rule |
| lock | the digest of the dod, fixed before the first tool call | hash, signature, commit |
| held, pending, broken | the three dod verdicts | passed, failed, success, error, green, red |
| settle | what Oxagen does to a dod when the run reports its stop | stamp, certify, finalize |
| verify | recompute a verdict from an export | audit, validate, confirm |
| witness | Oxagen's hidden check, run in the witness runner | hidden test, oracle (except when naming the oracle kind) |
| proven | a run whose witness verdict is `flipped` | verified, validated, correct |
| done | a run whose dod is held | complete, finished, successful |
| wrap | install Oxagen on a harness | integrate, onboard, connect |
| wrapper | the hooks or SDK adapter beside the agent | harness (the harness is Claude Code itself), plugin, agent |
| seal | the signed close of a run | finalize, commit |
| export | the file a run produces for offline verification | report, bundle, artifact |
| Spend, Run, Fleet, Access | the pages, capitalized | dashboards |
| mandate | the one object an agent runs under: access, budget and rules, equipment, record | policy, config, profile, permission set |
| clause | one of the four parts of a mandate, owned by one team | section, setting, module |
| request | an agent asking for a system, scope, or action at the moment of use | grant, token, permission (as the thing handed over) |
| rule | what answers a request: allow, deny, or route to a person | policy (as the answer), guardrail, filter, approval workflow |
| allowed, denied, routed | the three answers a rule gives | approved (fine for the person's act), blocked, escalated, flagged |
| connection | a system Oxagen reaches on the agent's behalf, credential held by Oxagen | integration (as the noun), the agent's API key, service account |
| credential | the secret Oxagen holds and the agent never sees | key (except in the line that says not to hand it over), secret (fine in docs) |
| fleet | every agent an organization runs, whoever built them, seen as one population | swarm, army, workforce, team of agents |
| fleet management | the operator's job: see the fleet, answer its requests, fund it, hold it, stop it, and carry its spend | orchestration, agent ops, AgentOps, monitoring |
| spend management | the FinOps half of fleet management: budgets, meters, rules, the bill per agent, run, and person | cost observability, FinOps tooling, chargeback |
| operate | what an operator does to a fleet under a mandate | run (Oxagen never runs the agent), orchestrate, drive |

## Verbs that carry the brand

ask, request, allow, deny, route, answer, lock, block, hold, break, settle, verify, wrap, record, seal, decide, read, show, cost

## Avoid these

### Words that mean nothing
seamless, robust, powerful, revolutionary, cutting-edge, next-generation, game-changing, best-in-class, world-class, enterprise-grade, comprehensive, holistic, end-to-end, turnkey, frictionless, effortless, intelligent, smart, magic

### Intensifiers
very, really, truly, genuinely, incredibly, extremely, deeply, highly, super

### Emotional sells
excited, thrilled, proud, delighted, love, passionate, finally, at last, imagine

### Fear sells
liability, risk (as a scare word), exposed, unchecked, rogue, dangerous, protect, safeguard

### Category words owned by others
observability, governance (as a category name; fine as a verb and as one of the five jobs), evals, guardrails, trust layer, safety layer, AI ops, LLMOps, AgentOps, orchestration (as a category name)

### Overclaims
proven (for anything the dod did), verified (for anything a model did), guaranteed, always, never (about outcomes), 100%, zero, eliminates

### Wrong-vocabulary words
session, trace (as a noun for a run), attempt, execution, invocation, span, action event, re-run, render replay, stamp (dod), certificate (dod v4 has none)

### Product words we do not use
AI-powered, LLM-powered, autonomous (as a compliment for Oxagen; fine as a plain description of the agents it manages: "autonomous agents"), agentic (as an adjective for the product), copilot, assistant

### Words that hand over the keys
connect your agent to, give the agent access to, full access, the agent's API key, the agent's token, service account (for an agent), one-click connect, auto-approve (as a feature), hand over (except in the line that says not to), least privilege (say what it means: the agent asks for what the task needs, when it needs it)

### Filler that opens sentences
In today's world, As AI agents become, With the rise of, It's no secret that, We believe, We're on a mission

## Replacements for common bad lines

| Bad | Good |
|---|---|
| ensure your agents deliver | block the run until the dod holds |
| seamless integration with Claude Code | two hooks in Claude Code |
| AI-powered verification | a pure function of the run's frames |
| comprehensive observability | every frame with its cost beside it |
| enterprise-grade security | the agent never sees the key |
| connect your agent to GitHub | the agent can request GitHub |
| the agent has access to Slack | Slack is in the agent's mandate |
| securely stores your keys | the credential stays in Oxagen |
| auto-approved | allowed by rule |
| escalated to a human | routed to a person |
| least-privilege access | the agent asks for what the task needs, when it needs it |
| gain visibility into | see |
| leverage | use |
| enable you to | lets you, or cut it |
| in order to | to |
| utilize | use |
