# ADR-024: Strict three-part capability naming

**Status:** Proposed (2026-07-07)
**Related:** ADR-022 (capability & tool naming standard, which this tightens and partially supersedes), ADR-009 (unified capability/tool model via `surfaces`), `docs/VISION.md`

## Context

ADR-022 established `domain.subject.action` as the canonical capability name shape, but permitted a **2-segment** `domain.action` form whenever "the implied subject is the domain's root entity" (§2, the *subject-elision rule*) — `connection.list` standing in for "list connections", `workflow.run` for "run the workflow". That escape hatch was pragmatic (it let the ADR-022 wave land without touching ~100 pre-existing names), but it reintroduces exactly the ambiguity ADR-022 was written to kill: a model or a new contributor cannot tell, from the string alone, whether a 2-segment name is "verb-elision" or "subject read with an implied get" (ADR-022 §2's own two blessed readings), and the elided subject is frequently not actually the domain's root entity at all — `connection.list` lists *connections*, but the connections themselves conceptually belong to the *graph* domain, not to a free-floating `connection` domain. Elision was hiding a mis-homed domain, not just a missing word.

A second class of drift ADR-022 left unaddressed: **subject plurality**. ADR-022 mandated singular subjects uniformly ("a capability that returns many rows still names its subject in the singular"), but auditing the current name set shows a pattern in several contracts — `agent.subagent_fanout.list`, `agent.memory.list`, `graph.node.list` — of implicitly plural intent hiding behind a singular subject, indistinguishable at a glance from the single-instance reads (`graph.node.get`) sitting right next to them under the same domain/subject pair. A model choosing between `graph.node.get` and `graph.node.list` gets no lexical signal that one returns one row and the other returns many; the tool description has to do all the work the name shape should be doing.

ADR-022 also left a 14-entry `GRANDFATHER` map of names it declined to fix in its own wave (noun-terminal reads such as `billing.usage.breakdown`, `schema.validate.node`'s action-in-the-middle ordering, etc.) — explicitly flagged as "the running ledger of naming debt" for "a follow-up wave" (ADR-022 §7, Consequences).

This ADR is that follow-up wave, tightened further: it removes the escape hatch entirely rather than shrinking it.

## Decision

### 1. Canonical form: `domain.subject.verb` — **exactly three segments, always**

Every capability name is **exactly three** dot-separated segments. There is no 2-segment form. The ADR-022 §2 subject-elision rule is **removed** in its entirety — a name that used to read `domain.action` must gain an explicit subject, either by inserting one under the same domain or by re-homing to the domain the subject actually belongs to (see §2 below).

Segment charset is unchanged from ADR-022: lowercase `[a-z0-9]` words, optionally joined by `_` inside a segment for a compound concept, three segments joined by `.`. Kebab-case remains illegal everywhere.

### 2. Domain: singular noun, the entity's true owner

**domain** is a singular noun naming the top-level area the subject conceptually **belongs to** — not merely the shortest available prefix. Where the pre-ADR-024 name used the subject's own name as a pseudo-domain (`connection.list`, `repo.create`, `environment.create`), the correct domain is worked out by asking "what larger thing owns this entity?", not by mechanically padding the existing string:

- Connections belong to the knowledge graph (they exist to populate it): `connection.list` → `graph.connections.list`, not `connection.connection.list`.
- Environments and workspaces belong to the org/workspace hierarchy that scopes them.
- Generated artifacts (documents, images, video, svg, markdown, mermaid, archives) belong to one asset domain, not eight parallel one-capability domains.

This is a **semantic re-homing** exercise, not string padding, and it is the primary source of judgment calls this ADR generates (tracked exhaustively, with a proposed name for every capability, in `docs/specs/adr024-naming-mapping.md`).

### 3. Subject: singular for one instance, plural for a collection

**subject** is a noun naming the entity the verb operates on, and its number now carries meaning:

- **Plural** when the verb returns or affects a collection (`graph.connections.list`, `agent.subagents.list`, `graph.nodes.list`).
- **Singular** when the verb operates on exactly one instance (`content.document.create`, `repo.file.edit`, `agent.subagent.stop_agent`, `graph.connection.get`).

This sharpens (does not reverse) ADR-022 §1's "subject and domain segments are singular nouns" rule: ADR-022 pre-dated this ADR's audit finding that several `.list`-suffixed names carry a singular subject despite listing a collection (`agent.memory.list`, `graph.node.list`) — those are naming defects to fix under this ADR, enumerated in the mapping doc, not a conflict with ADR-022's original intent (ADR-022 didn't anticipate the collision between "singular subject" and "plural cardinality" because it never separately called out list ops as a case).

### 4. Verb: MAY be a snake_case compound

The final segment is drawn from the same closed action vocabulary ADR-022 §4 established (maintained in `tools/scripts/check-naming.mjs`). It may be a snake_case compound of two or more vocabulary-adjacent words when a single verb is ambiguous or collides with a sibling capability in the same domain — `dispatch_agent`, `stop_agent`, `pause_all`, `send_message`, `read_message`, `checkpoint`, `dispatch_swarm`, `eval_agent`, `get_status`, `list_neighbors`, `get_lineage` are all legal single verbs. This is unchanged from ADR-022 §4's existing allowance for snake_case compound actions; this ADR simply leans on it harder now that noun-terminal grandfather entries (`billing.usage.breakdown`, `eval.run.status`, …) must resolve to a real verb instead of shipping non-conforming.

### 5. The subject-elision rule is removed; the grandfather list is cleared

ADR-022 §2 (2-segment names) is struck. ADR-022 §7's 14-entry `GRANDFATHER` map is retired as part of this wave's rename — every entry gets a conforming 3-segment name (see the mapping doc) instead of remaining permanently exempted. `tools/scripts/check-naming.mjs`'s `GRANDFATHER` map is **not deleted immediately** — it stays in the lint as a comment-flagged relic until the renames in the mapping doc are actually executed, at which point it empties to zero. The proposed lint revision in this same branch documents this explicitly (see `tools/scripts/check-naming.mjs`, "ADR-024 will empty this map").

### 6. Aliases: unchanged, and load-bearing for every rename in this wave

ADR-022 §6's alias mechanism is unchanged and is exactly how every rename in this wave ships without breaking a caller:

- Every renamed contract carries `aliases: [<oldName>, …]`.
- The registry (`packages/oxagen/src/registry.ts`) resolves an alias to its canonical contract; `getCapability(alias)` works exactly as before.
- The kernel meters and gates (IAM/billing/entitlement) every call under the **canonical** name regardless of which name the caller used.
- IAM's `fetch-authz` matches legacy `role_grants` rows keyed by an old name via the alias index — no data migration required.
- API HTTP paths and CLI command paths are hand-authored and independent of the capability name; they do not change.

Nothing in this ADR authorizes retiring an alias. An alias is a permanent shim until a separate, explicit migration retires it (ADR-022 §6, unchanged).

### 7. Lint enforcement

`tools/scripts/check-naming.mjs` is revised (proposed diff on this branch) to:

- Enforce **exactly 3 segments** — the 2–3 segment range in the current `NAME_RE` becomes exactly 3.
- Keep the same charset rules and the same closed action vocabulary, noting the final segment may be a snake_case compound.
- Add best-effort **warning-level** heuristics for subject plurality (e.g. a `.list`/`.search`-suffixed name whose subject doesn't already look plural triggers a warning, not a hard failure) — plurality is a judgment call the tooling cannot fully mechanize, so it is surfaced for human review rather than block CI.
- Retain the `GRANDFATHER` map unmodified until the mapping doc's renames are executed; a code comment marks it for deletion once emptied.

## Consequences

- **This ADR is a proposal only.** No contract's `name` field, no route, no MCP tool, and no registry code changes as part of landing this document — see `docs/specs/adr024-naming-mapping.md` for the full enumerated violation list and the "Questions for the user" section that must be answered before any rename executes.
- **Renames are large in count** (this ADR's audit found 160 non-conforming capability names out of 294 total: 102 pre-existing 2-segment names, all 14 ADR-022 grandfather entries, and ~44 additional 3-segment names whose subject plurality or domain the new stricter rule flags) but **zero in blast radius per §6** — every one carries an alias, so no caller, IAM grant, or external integration breaks.
- **Domain re-homing is the largest source of judgment calls.** Several families (`connection.*`/`repo.*` → `graph.*`, `conversation.*` → `chat.*`, `environment.*` → `workspace.*`, `workspace.*` → `org.*`, `document.*`/`image.*`/`video.*`/`svg.*`/`markdown.*`/`mermaid.*`/`archive.*` → `asset.*`, `integration.*` ↔ `plugin.*`) require a human decision before execution; they are grouped as questions, not left to be silently resolved by whichever agent executes the rename.
- **Two likely duplicate-capability findings surfaced by this audit** (not renames, but bugs to verify): `budget.policy.*` vs. `workspace.budget_policy.*` look like the same capability under two names, and `conversation.chat` looks like it may duplicate `chat.message.send`. Both need verification, not just a rename, before execution.
- **Follow-ups after execution**: (a) retire the `GRANDFATHER` map entirely once its 14 entries are renamed; (b) promote the plurality heuristic from warning to error once the mapping doc's renames land and false positives are tuned out; (c) revisit MCP tool underscore-form migration (ADR-022 §3), unaffected by this ADR.
