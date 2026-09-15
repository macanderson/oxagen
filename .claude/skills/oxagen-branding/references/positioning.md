# Positioning

Read this before writing any headline, hero, tagline, ad, or opening sentence.

## The claim

Every other layer covers one clause of an agent's mandate and stops. Identity says who the agent is. Gateways say which tools it can call. Billing says what it consumed. Prompt repos say what it was told. Oxagen binds all of it into one object, enforces it on every call, and keeps a record an outside party can read.

## The category

**The agent control plane.** The control plane for every agent an enterprise runs, whoever built it.

Not observability. Not governance. Not evals. Not guardrails. Not a trust layer. Each of those is owned by someone, and each one means "watch and report." Oxagen acts: it answers the request before the action happens and blocks a run from ending before its definition of done holds. Name the category by what it does. A control plane does not run the workload. It decides what the workload may do, hands it what it needs, and keeps the record. Oxagen does not run agents.

## The mandate

The unit the control plane manages is the mandate. Three teams each write one clause, the platform keeps the fourth, and the whole thing is enforced on every run.

| Clause | Who sets it | What it says |
|---|---|---|
| Access | Security | Which identity the agent acts as, which systems it may ask for, which data and graph scope it may read, which actions it may request |
| Budget and rules | FinOps | What it may spend, under which commercial terms, and the rules it must obey: approval thresholds, allowed vendors, decision rules |
| Equipment | Engineering | The knowledge it is handed at the start of a job, the skills and tools it may use, the steering it runs under |
| Record | The platform | What the run read, what it changed, what proved it, what it cost |

Lead with the clause the reader owns. A security lead reads access first. A finance lead reads budget first. An engineering lead reads equipment first, then the record.

## The keys stay with you

Never hand an agent the keys. This is the sentence under the access clause, and it shapes every line about connections, credentials, permissions, and tools.

The wrong model, the one every other tool assumes, is a service account: the agent is given a token with everything it might ever need, and the team hopes it uses only some of it. Oxagen's model is a request. The agent holds an identity and a mandate, and nothing else. When a task needs a system, a scope, or an action the mandate does not already cover, the agent asks for it at the moment of use. Each request names who started the task, which agent is asking, which tool it wants, and which data it would reach.

A rule answers the request. The team that owns the system writes the rule, and a rule has three answers: allow, deny, or route it to a named person. Allowed and denied requests settle inside the same call and leave a row. Routed requests wait for the person, and the run waits with them. The credential never leaves Oxagen. Oxagen makes the connection on the agent's behalf and closes it when the action is done. The answer, the rule that gave it, and the person who signed it are in the record.

Write it this way on every surface:

- **The agent asks.** Never "the agent has access to Slack" or "connect your agent to Slack". Say "the agent can request Slack" or "Slack is in the agent's mandate".
- **The rule decides.** Name the three answers when there is room: allowed, denied, routed to a person. A rule that always allows is still a rule someone wrote and can read; that is the point, not a shortcut.
- **The record keeps the answer.** Every request is a row with the rule that answered it and, when routed, the name of the person who did.
- **The key never moves.** Say the credential stays in Oxagen and the agent never sees it. Never "securely stores your keys"; every vault says that. Say what is different: there is no key to hand over, so there is nothing for the agent to leak.
- **No fear.** The reader has already pasted a token into an agent and knows it. Do not tell them it was dangerous. Tell them what the request looks like and who answers it.

Proof points, stated so they survive a rebuttal:

- **Three answers, one rule.** A decision rule names a capability, a condition, and one effect: allow, deny, or require approval. The kernel checks it after identity and entitlement and before the handler runs, so a denied action never reaches the code that would have done it.
- **Routing is built in.** Any action can be marked as needing a person. The run pauses on the request, the person answers from the Access page, and the run resumes with the answer in the record.
- **The credential is Oxagen's to hold.** Connections are held by the workspace, encrypted under a key you own, and used inside the platform on the agent's behalf.
- **Every request is a row.** Who started the task, which agent asked, which tool it wanted, what data it would reach, which rule answered, and who signed. The same row the meter prices.

## The lead line and when to use each line

**Decision, 2026-09-15 (Mac):** the dod does not ship yet, so the dod lines are
held until it does. Until then the lead is the bill. The first three lines below
come from the shipped house ads in `oxagenai/oxagen-brand`. The fourth is the
access line, added 2026-09-15 for the security reader. These are the only lead
lines for the site, ads, and outreach today. When the dod lands, the dod lines
move back to the top of this table; nothing else changes.

| Line | Use it for | Why it works |
|---|---|---|
| **Can you explain your AI bill? Neither can your provider.** | The top of the site, cold email subject lines, the bill ad | Names the pain the buyer feels this month, and the product proves it today: every call priced by token class, attributed to the person, agent, run, turn, and step. |
| **Stop wasting money on AI.** | The Oxagen product page, the waste ad | Fewer tokens, same answers. The claim the record can back now. |
| **Never re-explain yourself to AI ever again.** | The memory ad, the knowledge graph section | Taught once, known by every agent you run. |
| **Don't hand your agents the keys.** | The access section of the site, the security page, cold email to security leads | Names the thing every security lead has already done and regrets. The next sentence is the product: the agent asks, a rule you wrote answers. |

Held until the dod ships:

| Line | Use it for | Why it works |
|---|---|---|
| **The agent doesn't get to decide it's done.** | Rooms, decks, the top of the site, cold email subject lines | Names the failure every engineering lead has lived. The reader finishes the thought. |
| **Define done before the agent starts. Prove it after.** | Product pages, docs intros, anything explaining both halves | Both halves in one sentence: the visible dod and the hidden witness. |
| **Runs that end with a verdict, not a claim.** | Finance, procurement, the CFO slide | Says the meter follows the outcome without saying the word pricing. |
| **Prove it to someone who doesn't trust you.** | The verify feature, audit and insurance conversations | Names the outside dependency, which is the moat. |
| **Steer. Govern. Observe.** | Footer, favicon-sized places, the existing three pillars | Retained from the current system. Never the lead; the lead is the dod. |

Do not write new taglines. If a surface needs a line, pick one above, from the live rows.

## The pitch, three sentences

Your agents run on a token somebody pasted in, spend against a budget nobody set, and finish when they say they are finished. Oxagen puts each agent under a mandate: security sets what it may ask for, FinOps sets what it may spend and the rules it obeys, engineering sets what it knows and what it may use, and the platform enforces all of it on every call. Every run leaves one record, what it read, what it changed, what it cost, and what proved it, that an auditor can read without trusting you.

## The pitch, one sentence

Oxagen is the control plane for the agents an enterprise runs: one mandate per agent, set by the teams accountable for it, enforced on every call, recorded on every run.

## Proof points, stated so they survive a rebuttal

- **One object, enforced at the call.** Identity, knowledge scope, permitted action, commercial terms, outcome, and audit record are one typed contract, checked when the agent calls, not reconstructed after the incident.
- **The meter is a row, not an estimate.** Every governed action is priced and attributed to the person, the agent, the run, the turn, and the step. The bill page and the record page read the same rows.
- **Your keys, your graph, your model.** Own model keys, own graph endpoint, hosting at cost. There is no cloud the product pulls toward.
- **Whoever built the agent.** Claude Code, the Agent SDK, a custom loop. The wrapper records and gates from beside the agent; Oxagen never has to run it.

Held with the dod lines:

- **Pre-committed, not post-hoc.** The dod is locked before the agent moves, and its position in the run's chain proves it. Evaluation tools score afterward, with a model that has the same blind spots as the model that did the work.
- **Two halves, on purpose.** The dod is fully visible to the agent, so drift is caught where it happens. The witness is invisible to the agent, so gaming is caught where it hides.
- **No model in the verdict.** `decide()` is a pure function of the run's frames.
- **Third parties depend on the record.** `oxagen dod verify` runs with no account and no network.
- **The meter follows the proof.** Charge for proven runs. Report runs and governed actions as secondary meters.

## The buyer and the sentence they repeat

Three readers, one mandate.

- The security lead, after a month: "The agents don't have a token any more. They ask, and I can read every answer."
- The finance lead, reading the Spend page without translation: "I can say which agent spent what, on whose behalf, under which rule."
- The engineering lead running terminal agents: "I stopped reading agent PRs to find out if they were done."

Coding teams first, because everyone using a terminal agent today is a customer.

## The demo, in order

Type a prompt in Claude Code. Show the mandate the agent runs under. Let it request a push to a protected branch and get denied, with the rule id. Let it request one to a release branch and watch it route to a person, answer it from the Access page, and see the run resume. Open the run and show the request beside the tool call with its cost. Twenty minutes, one denied request, one routed request, one record.

## Competitive framing

Never name a competitor in copy. Describe the category behavior instead: "tools that record," "a token with everything the agent might ever need," "scores written after the fact," "a second model grading the first." The reader supplies the names.

## What not to say, and why

- **Trust layer, safety, guardrails.** These sell fear. The buyer is not afraid; they are annoyed.
- **AI-powered verification.** The verdict has no AI in it. That is the point.
- **Connect your agent to, give the agent access to, the agent's API key.** Each one hands over the keys in the copy even when the product does not. The agent asks; the rule answers.
- **Auto-approve, as a feature.** A rule that allows is not automation; it is a decision someone wrote down. Say "allowed by rule".
- **The fourteen oracles, the ladder, the rating, Vera.** Year-two story. Telling it now is the surface-area problem.
- **Stamp.** Belongs to the witness. The dod settles; it does not stamp.
- **Proven, for anything the dod did.** A held dod means done. Proven is the witness verdict `flipped` and nothing else.
