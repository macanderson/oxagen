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
| Spend, Run, Fleet | the pages, capitalized | dashboards |

## Verbs that carry the brand

lock, block, hold, break, settle, verify, wrap, record, seal, decide, read, show, cost

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
observability, governance (as a category name; fine as a verb), evals, guardrails, trust layer, safety layer, AI ops, LLMOps

### Overclaims
proven (for anything the dod did), verified (for anything a model did), guaranteed, always, never (about outcomes), 100%, zero, eliminates

### Wrong-vocabulary words
session, trace (as a noun for a run), attempt, execution, invocation, span, action event, re-run, render replay, stamp (dod), certificate (dod v4 has none)

### Product words we do not use
AI-powered, LLM-powered, autonomous (as a compliment), agentic (as an adjective for the product), copilot, assistant

### Filler that opens sentences
In today's world, As AI agents become, With the rise of, It's no secret that, We believe, We're on a mission

## Replacements for common bad lines

| Bad | Good |
|---|---|
| ensure your agents deliver | block the run until the dod holds |
| seamless integration with Claude Code | two hooks in Claude Code |
| AI-powered verification | a pure function of the run's frames |
| comprehensive observability | every frame with its cost beside it |
| enterprise-grade security | the agent holds no credentials |
| gain visibility into | see |
| leverage | use |
| enable you to | lets you, or cut it |
| in order to | to |
| utilize | use |
