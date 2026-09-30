# Core

Read this before any other reference. It holds the definition, the rules, and the checklist every Oxagen and Stella asset answers to. When a line here and an entry in `messages/index.json` disagree, the registry wins.

## Definition

Oxagen is workforce management for autonomous agents: give each agent an identity, set its authority and budget, equip it with tools and skills, and review what it did and what its operators spent, through a shared agent control plane.

Every piece of copy is downstream of that sentence. **Workforce management for autonomous agents** is the product and the lead: the job the operator is doing. **Agent control plane** is the technical category: what Oxagen is to the systems it governs. A control plane does not run the workload. It decides what the workload may do, hands it what it needs, and keeps the record. Oxagen does not run agents.

The unit Oxagen manages is the mandate. Each agent has its own identity and works under one mandate with four clauses: access (security sets it, including the identity the agent acts as), budget and rules (FinOps sets it), equipment (engineering sets it: tools, skills, and permitted knowledge), and the record (the platform keeps it). These responsibilities can belong to one person or to several teams. If a line does not connect to identity or a clause, cut the line.

Completion is optional. A definition of done is a control for bounded tasks that have an endpoint. Ongoing responsibilities are managed through authority, budget, and review points, with no artificial finish line. The dod is never the lead.

## The six rules that never bend

1. **Gold is identity, plus at most one action per screen.** Gold never carries state and never fills a surface. State is carried by shape: double border for held, dashed for pending, single for broken.
2. **No em dashes in anything a customer reads.** Use a period, a comma, or a colon. This includes UI strings, docs, ads, and specs.
3. **Sentence case headings.** Always.
4. **Wordmarks are lowercase: oxagen, stella.** In prose they are names and take a capital: Oxagen, Stella.
5. **The workforce vocabulary is the product's vocabulary.** Run, turn, step, frame, operator, agent, workspace, governed action, mandate, request, rule. Use the exact terms for UI labels and on detail pages. Familiar explanatory language around them is fine. Never session, trace, attempt, execution, or invocation in customer-facing prose. See `words.md`.
6. **The agent asks, the rule decides, the record keeps the answer, for actions routed through Oxagen.** Each agent has its own identity. For mediated connections, Oxagen uses the connection credential on the agent's behalf and the agent does not receive it. A rule the owning team wrote answers each request: allowed, denied, or routed to a person. State that scope beside the claim. Never write "connect your agent to X" or "give the agent access to X", and never promise that an agent has nothing to leak. See *The keys stay with you* in `positioning.md`.

## Positioning

The operator's job is to give each agent an identity, set its authority and budget, equip it with tools and skills, and oversee what it does. Oxagen is where that job happens. The agent control plane is what makes those decisions apply to the actions routed through Oxagen and keeps the record of them.

Other layers each cover one part of that job. Identity systems say who the agent is. Gateways say which tools it can call. Billing says what it consumed. Prompt repos say what it was told. Oxagen binds those decisions into one mandate per agent, applies it to governed calls, and records each decision. Observe mode is recorded, not enforced. Say which one applies.

Some work has an endpoint. For those bounded tasks, define completion before the work starts. A passing verdict means the specified checks held, and the team decides whether those checks are enough. Other work continues. Keep its authority, activity, and spend in view as it runs.

The homepage eyebrow, the headline, and the line for each reader (security, finance, knowledge) are the `lead` and `access` entries in `messages/index.json`. Use the approved, launch-released ones. The dod lines are held until the dod ships and then apply to bounded tasks only. The reasons behind each line, and the retired lines with what replaced them, are in `positioning.md`.

## Always-on

Mac's draft of 2026-09-26 adds an always-on pillar. The agents keep working after the operator's day ends, and the operator comes back to a report. Its lines sit in `messages/always-on/`, and `messages/index.json` gives each one's status. Only approved lines ship. A candidate waits for Mac. `always-on-lines.md` lists every line with its status, and `always-on.html` sets them as ads, banners, website sections, and calls to action.

Three rules hold for every always-on line. Oxagen governs the agents and does not run them. Every run keeps an owning operator, so going home hands off the hours and keeps the ownership. The record covers governed actions, so a line about automatic records says so. The sets, the pairings, and the lines that need Mac's decision are in `always-on.md`.

## Voice

Oxagen sounds like a senior engineer who has read the logs and is telling you what happened. Plain, specific, unhurried, a little dry. It states facts, names numbers, and stops. It never sells fear, never says "AI-powered", and never claims more than the record shows.

Full guidance, with before and after pairs, is in `voice.md`.

## Prose rules that apply everywhere

- Actor first. "The rule denies the push" not "The push is denied by the rule."
- Concrete verbs. Ask, allow, deny, route, assign, equip, lock, block, settle, verify, hold, break. Not enable, empower, leverage, ensure.
- One idea per sentence. If a sentence has a semicolon, it is two sentences.
- Numbers over adjectives, when the number is measured and dated. "Blocked once, held on the second stop" beats "reliable."
- A feature pairs with what it does for the reader in the same sentence.
- Never strengthen a claim past the evidence. A held dod means the specified checks held, not that the work is correct. Proven is the witness's word, and only beside a witness flip and its scope. An allowed request means a rule allowed it, not that the action was safe.
- Scope every control claim. "For actions routed through Oxagen" or "on governed calls", never "on every call" or "on every run" alone.
- Cut "very", "really", "seamless", "robust", "powerful", "revolutionary", and every word in `words.md` under avoid.
- Say Oxagen, not "we", in product copy. Say "you", never "users", when addressing the reader.

## Headings and labels

A heading names the thing, a caption states one fact, and no label carries a comma, a mid-dot, or a "not / never" contrast. Subtext under a heading is one sentence or nothing. Banned on 2026-09-21: "Retrieval, in numbers", "Summary · what this run changed", "ordered by the frames, not by kind", "what Oxagen injected, and what it cut". Write "Retrieval stats", "Summary", "Frame order", "Injected context".

## Checklist before shipping any asset

- [ ] One gold action at most; gold nowhere else except the mark
- [ ] State shown by shape, not color
- [ ] No em dashes
- [ ] Headings in sentence case, and every heading a plain noun
- [ ] oxagen and stella lowercase as marks, capitalized in prose
- [ ] No forbidden vocabulary (`words.md`)
- [ ] First sentence connects to the one-sentence definition and names identity or a mandate clause
- [ ] No agent holds a key, a token, or standing access anywhere in the copy; it asks, a rule answers
- [ ] Claim scope stated: control claims say "routed through Oxagen" or "governed calls", and observe mode says recorded, not enforced
- [ ] No leak promise. Credential custody is stated for mediated connections only
- [ ] No savings claim without the measured workload and conditions
- [ ] No SOC 2 attestation claim unless the actual report supports it
- [ ] Completion is presented as optional, for bounded tasks, and never as the lead
- [ ] An operator review line reports what the record shows, with each habit's definition beside it, and does not grade the person. The one ranking of people is the manager's ranking of operators by unproductive spend (decided 2026-09-27)
- [ ] Short forms keep the qualifiers of their longer versions
- [ ] Buyer quotes are labelled hypothetical unless an attributed customer approved them
- [ ] No traction numbers, partner counts, or setup durations without dated evidence
- [ ] Every claim is one the record can back
- [ ] Space Grotesk for wordmarks and h1 to h3 only, Geist for h4 to h6, body, and UI, Monaspace Neon for code, data, digests, and commands
- [ ] One type scale per surface: marketing (`text-m-*`) or app (`text-a-*`)
- [ ] Card radius 12px on the website and 13px in the app, 1120px wrap, dark first on obsidian with the white light theme intact
- [ ] Gold as text on white is the `gold-deep` token, never the gold itself
- [ ] Every text role that carries meaning clears 4.5:1 on its ground
- [ ] Every colour and face comes from `tokens/`, imported, never retyped
