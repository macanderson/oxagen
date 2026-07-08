# ADR-024 naming mapping — proposed renames (PROPOSAL, no code executed)

**Status:** Awaiting user review. Nothing in this document has been applied — no contract `name` field, route, MCP tool, or registry entry has been touched. This is the enumerated violation list and rename proposal required before any execution PR.

**Source of truth:** every capability whose contract file under `packages/oxagen/src/contracts/*.ts` calls `registerCapability(...)`, extracted mechanically from the `name:` field (294 total capabilities found; shared schema modules with no `registerCapability()` call are excluded, matching the existing lint's own filter).

**Violation count:** **160 of 294** capability names (54%) do not conform to the ADR-024 `domain.subject.verb` standard — see `docs/adr/ADR-024-strict-three-part-naming.md` for the rule itself. Breakdown:

| Source of violation | Count |
|---|---|
| Pre-existing 2-segment names (ADR-022 §2 elision, now removed) | 102 |
| ADR-022 §7 grandfathered noun-terminal 3-segment names | 14 |
| Additional 3-segment names with singular subject on a collection (`.list`/`.search`) verb, newly caught by ADR-024 §3 | 24 |
| Additional 3-segment names using the request **scope** (org/workspace) as the subject instead of the entity acted on | 8 (subset already counted above where they were also `.list`) |
| Likely duplicate-domain findings flagged for verification, not just renamed | 4 (`budget.policy.*` × 2, `conversation.chat`, `integration.*` family) |
| **Total flagged rows** | **160** |

**Confidence split:**

- **`mechanical` — 59 rows.** The rule applies unambiguously: either the contract's own description names the subject explicitly, the fix directly clears an ADR-022 `GRANDFATHER` entry using that entry's own suggested resolution, or the fix mirrors an exact existing sibling shape elsewhere in the codebase (e.g. `workflow.run.*` mirroring `eval.run.*`).
- **`NEEDS-USER-DECISION` — 101 rows.** Domain re-homing, a subject choice with more than one defensible answer, or a likely duplicate capability that needs verification before it's safe to rename at all.

---

## Questions for the user

These are the judgment calls, grouped by family so you can answer once per family rather than once per row. Every question already has a best-guess proposed name in the full table below if you'd rather just skim-approve.

### 1. Connections and repos — re-home under `graph`?
`connection.*` (10 capabilities) and `repo.*` (13 capabilities, including the grandfathered `repo.ci.status`) currently live under their own top-level domains. Connections and repos both exist to feed the knowledge graph (repo.configure's own description literally calls itself a specialization of `connection.configure`). **Proposal:** re-home both families under `graph` — `connection.list` → `graph.connections.list`, `repo.create` → `graph.repo.create`, etc. **Question:** do you want this re-home, and do you want repos folded into the *same* `graph.repo.*` shape as connections, or kept as a visually distinct `graph.repository.*` subject so they don't read as interchangeable with generic data-source connections?

### 2. Conversations and chat — merge into one domain?
`conversation.*` (9 capabilities) and `chat.*` (2 capabilities, one grandfathered) look like two parallel domains for the same concept (message threads). **Proposal:** merge `conversation.*` under `chat` (`conversation.list` → `chat.conversations.list`). **Also flagging a likely duplicate:** `conversation.chat` ("Post a message to a conversation") reads as the same operation as `chat.message.send` — worth checking whether one is dead code before renaming either. **Question:** approve the merge, and should someone verify/retire the `conversation.chat` vs `chat.message.send` duplicate as a prerequisite?

### 3. Environments and workspaces — nest under their owning scope?
`environment.*` (6 capabilities) are workspace-scoped deploy configs; `workspace.create`/`workspace.list` (2 capabilities) are themselves org-scoped. **Proposal:** `environment.*` → `workspace.environment.*`; `workspace.create`/`workspace.list` → `org.workspace.*`. **Question:** approve both re-homes? (They're independent of each other — you can accept one without the other.)

### 4. `org.create` / `org.list` — new `platform` domain, or a different subject under `org`?
Org is the top of the tenancy tree with nothing bigger to nest under in this codebase. Padding to 3 segments without a bigger parent domain means either (a) inventing a new top-level `platform` domain as the account-level root (`platform.org.create`, `platform.orgs.list`), or (b) keeping `org` as the domain and choosing a subject synonym that isn't just "org" again (e.g. `org.account.create` — awkward, since org *is* the account). **Question:** which do you prefer, or is there a domain name you'd rather use than `platform`?

### 5. Notifications — belong to `user`?
`notification.list`/`notification.mark` (2 capabilities) are both scoped "for the calling user." **Proposal:** re-home under `user` (which already owns `user.preferences.*`): `user.notifications.list`, `user.notification.mark`. **Question:** approve?

### 6. Ontology — fold into `graph`?
`ontology.neighbors`/`ontology.query` (2 capabilities) are graph traversal per CLAUDE.md's own description ("the `ontology.*` graph query layer"). **Proposal:** `graph.ontology.list_neighbors`, `graph.ontology.query`. **Question:** approve the re-home, and is `list_neighbors` an acceptable compound verb for the noun "neighbors," or would you rather add `neighbors`/`traverse` to the action vocabulary instead of compounding?

### 7. `integration.*` vs `plugin.org.*` — the same thing twice?
`integration.*` (7 capabilities: configure/delete/get/install/list/metrics/sync) looks like it duplicates the installed-plugin-instance CRUD that `plugin.org.*` already provides. **Question:** please have someone verify whether `integration.*` is live, dead, or genuinely distinct from `plugin.org.*` before any rename — if it's a duplicate, the fix is retiring one, not renaming both. If they ARE distinct, the proposed fix re-homes `integration.*` under `plugin` with subject `instance` (`plugin.instance.configure`, etc.) — approve that shape?

### 8. `budget.policy.*` vs `workspace.budget_policy.*` — literal duplicate?
Both `budget.policy.read`/`budget.policy.write` and `workspace.budget_policy.read`/`workspace.budget_policy.write` exist in the contract set, and the latter is already ADR-024-conformant. **Question:** please verify whether `budget.policy.*` is dead/superseded code before deciding whether to rename it (proposed: fold into `workspace.budget_policy.*`) or retire it outright.

### 9. Generated-content domains — consolidate under `asset`?
`document.*` (5), `image.*` (4), `video.generate`, `svg.generate`, `markdown.generate`, `mermaid.generate`, `archive.create`, and `asset.upload` — 14 capabilities across 8 one-or-few-capability domains — all generate or upload a binary/text artifact to blob storage. **Proposal:** consolidate all of them under the existing `asset` domain as subjects (`asset.document.create`, `asset.image.generate`, `asset.video.generate`, `asset.svg.generate`, `asset.markdown.generate`, `asset.mermaid.generate`, `asset.archive.create`, `asset.file.upload`). **Question:** approve the consolidation, and is `asset` the right parent domain name, or would you prefer `content`?

### 10. "Scope as subject" — `plugin.org.*`, `plugin.workspace.*`, `skill.workspace.*`
These 7 capabilities currently use the **request scope** (`org` / `workspace`) as the subject segment, when the entity actually being acted on is the installed-plugin or installed-skill record, not the org/workspace itself. **Proposal:** rename subject to `org_install` / `workspace_install` (`plugin.org.install` → `plugin.org_install.create`, `skill.workspace.list` → `skill.workspace_installs.list`, etc. — full list in the table). **Question:** approve this subject rename, and should `uninstall` stay as its own verb (`plugin.org_install.uninstall`) or become `delete` for vocabulary consistency with the rest of the CRUD set?

### 11. `code.*` tool subjects — one uniform subject, or four distinct ones?
`code.diff`, `code.format`, `code.map`, `code.patch` each act on a different sub-entity per their own descriptions (a file-blob pair, arbitrary source text, a symbol/file bundle, and a whole in-memory workspace, respectively). **Proposal:** `code.blob.diff`, `code.source.format`, `code.symbol_map.get`, `code.workspace.patch` — four different subjects, not one. **Question:** approve these four distinct subjects, or would you rather force a single uniform subject (e.g. `code.snippet.*`) even though it fits some of the four better than others?

### 12. `graph.cypher` / `graph.search` — subject choice to avoid colliding with `graph.node.*`
`graph.search` is explicitly described as distinct from the existing `graph.node.search` (embedding/vector search across the whole graph vs. lexical node search), so it can't reuse subject `node`. **Proposal:** `graph.cypher` → `graph.query.run`; `graph.search` → `graph.embedding.search`. **Question:** approve these subjects, or do you have a preferred pair of names that better signals "raw query" vs. "semantic search across everything"?

### 13. `web.fetch` / `web.search` — subject choice
**Proposal:** `web.page.fetch` (subject=page, fairly natural) and `web.query.search` (subject=query — more of a stretch, since "web" itself reads as the implicit object of "search"). **Question:** approve, or would you rather these two be folded into the `browser.*` family (which already gained a `page` subject in this wave) since they're conceptually adjacent?

### 14. `schema.*` root operations — subject `definition`?
`schema.chat`, `schema.delete`, `schema.export`, `schema.list`, `schema.recommend`, `schema.setup`, `schema.toggle` (7 capabilities) all act on the workspace's schema record, paralleling how `agent.definition.*` and (proposed) `skill.definition.*` name their root entity. **Proposal:** `schema.definition.*`, with `schema.list` → `schema.definitions.list`. **Question:** does a workspace genuinely have multiple schema definitions (making the plural `schema.definitions.list` correct), or exactly one (in which case `schema.list` may actually mean "list schema *templates*" and deserves a different subject than the workspace's own live definition, e.g. `schema.template.list`)?

### 15. `agent.compose` / `agent.deploy` — subject naming
**Proposal:** `agent.compose` ("Plan and execute a chain of capabilities") → `agent.capability_chain.compose`; `agent.deploy` ("Set an agent's deployment posture") → `agent.deployment_posture.set`. **Question:** approve these subjects, or do you have terser preferred names for "the chain of capabilities being composed" and "the deployment posture record"?

### 16. `secret.export` / `secret.import_env` / `secret.reveal` — subject choice
**Proposal:** `secret.environment.export` and `secret.environment.import_env` (these operate on the whole secret set for one environment), and `secret.value.reveal` (this one reveals a single secret's plaintext, matching the existing singular `secret.value.set`/`secret.value.unset` subject). **Question:** approve, particularly whether "environment" as a subject *inside* the `secret` domain reads clearly alongside the separately-proposed `workspace.environment.*` CRUD domain (same word, two different domains, referring to the same underlying entity from two angles).

---

## Full violation table (160 rows)

Confidence legend: **mechanical** = the rule applies unambiguously (explicit description, exact existing sibling precedent, or the ADR-022 grandfather entry's own suggested fix). **NEEDS-USER-DECISION** = domain re-homing, a subject choice with more than one defensible answer, or a suspected duplicate needing verification — see the numbered question above it maps to.

| Current name | Proposed name | Rationale | Confidence |
|---|---|---|---|
| `agent.compose` | `agent.capability_chain.compose` | "Plan and execute a chain of capabilities" — subject names the chain being composed. (Q15) | NEEDS-USER-DECISION |
| `agent.definition.list` | `agent.definitions.list` | New subject-plurality-by-cardinality rule: list ops need a plural subject. | mechanical |
| `agent.deploy` | `agent.deployment_posture.set` | "Set an agent's deployment posture" — subject names the posture record, action=set (already valid verb) rather than the ambiguous bare `deploy`. (Q15) | NEEDS-USER-DECISION |
| `agent.execution.lineage` | `agent.execution.get_lineage` | Clears ADR-022 grandfather entry using its own suggested fix (noun-terminal→get_lineage). | mechanical |
| `agent.execution.list` | `agent.executions.list` | Same plurality rule. | mechanical |
| `agent.file_lock.list` | `agent.file_locks.list` | Same plurality rule. | mechanical |
| `agent.mcp_consent.list` | `agent.mcp_consents.list` | Same plurality rule. | mechanical |
| `agent.mcp.list` | `agent.mcp_servers.list` | Own description: "List registered external MCP servers" — subject=mcp_servers, both pluralized and disambiguated from the singular-instance ops (agent.mcp.delete/register/set_enabled). | mechanical |
| `agent.memory_citation.list` | `agent.memory_citations.list` | Same plurality rule. | mechanical |
| `agent.memory_promotion.list` | `agent.memory_promotions.list` | Same plurality rule. | mechanical |
| `agent.memory.list` | `agent.memories.list` | Own description: "List the workspace's AgentMemory nodes" — discrete rows, not a mass noun; pluralize. | mechanical |
| `agent.sandbox_file.list` | `agent.sandbox_files.list` | Same plurality rule. | mechanical |
| `agent.skill.list` | `agent.skills.list` | Same plurality rule. | mechanical |
| `agent.subagent_fanout.list` | `agent.subagent_fanouts.list` | Own description: "List subagent fan-outs" — plural entity, straightforward pluralization. | mechanical |
| `agent.subagent.logs` | `agent.subagent.get_logs` | Clears ADR-022 grandfather entry using its own suggested fix. | mechanical |
| `agent.subagent.siblings` | `agent.subagent.list_siblings` | Clears ADR-022 grandfather entry using its own suggested fix. | mechanical |
| `agent.tool.list` | `agent.tools.list` | Same plurality rule. | mechanical |
| `agent.trigger.list` | `agent.triggers.list` | Same plurality rule. | mechanical |
| `archive.create` | `asset.archive.create` | Content-generation consolidation — archive.create already bundles other generated assets into a zip, so it belongs with them structurally. (Q9) | NEEDS-USER-DECISION |
| `asset.upload` | `asset.file.upload` | asset is becoming the parent domain for this whole family; the root-elided op needs its own non-redundant subject — proposing `file` for the generic binary upload. (Q9) | NEEDS-USER-DECISION |
| `automation.create` | `automation.playbook.create` | automation.create's own description: "Create a playbook and trigger for an automation" — subject is explicitly named. | mechanical |
| `automation.disable` | `automation.playbook.disable` | Same explicit subject. | mechanical |
| `automation.enable` | `automation.playbook.enable` | Same explicit subject. | mechanical |
| `automation.list` | `automation.playbooks.list` | Same explicit subject; plural (collection op). | mechanical |
| `automation.trigger` | `automation.playbook.trigger` | Same explicit subject; "trigger" is already a valid action verb. | mechanical |
| `automation.update` | `automation.playbook.update` | Same explicit subject. | mechanical |
| `billing.usage.breakdown` | `billing.usage_breakdown.get` | Clears ADR-022 grandfather entry using its own suggested fix. | mechanical |
| `browser.click` | `browser.page.click` | All browser.* ops act on "the current page" of a driven browser session; subject=page, singular (one page at a time). | mechanical |
| `browser.fill` | `browser.page.fill` | Same subject. | mechanical |
| `browser.navigate` | `browser.page.navigate` | Same subject. | mechanical |
| `browser.read` | `browser.page.read` | Same subject. | mechanical |
| `browser.refresh` | `browser.page.refresh` | Same subject. | mechanical |
| `browser.screenshot` | `browser.page.screenshot` | Same subject. | mechanical |
| `browser.submit` | `browser.page.submit` | Same subject. | mechanical |
| `budget.policy.read` | `workspace.budget_policy.read` | budget.policy.* and workspace.budget_policy.* appear to be the SAME capability under two names — verify and retire one (keeping workspace.budget_policy.* as canonical, already 3-segment-conformant) rather than renaming both. (Q8) | NEEDS-USER-DECISION |
| `budget.policy.write` | `workspace.budget_policy.write` | Same duplicate-domain flag. (Q8) | NEEDS-USER-DECISION |
| `chat.message.execution` | `chat.message.get_execution` | Clears ADR-022 grandfather entry (noun-terminal execution→get_execution); tied to the conversation/chat merge decision (Q2) even though this specific row needs no domain change. | NEEDS-USER-DECISION |
| `code.diff` | `code.blob.diff` | Diffs two file blobs per its own description; subject=blob distinguishes it from code.patch's workspace-wide target. (Q11) | NEEDS-USER-DECISION |
| `code.format` | `code.source.format` | Formats arbitrary source text inside the sandbox. (Q11) | NEEDS-USER-DECISION |
| `code.map` | `code.symbol_map.get` | Returns a structured code-map bundle (symbols/files) for a concept query — noun "map" needs an explicit get verb. (Q11) | NEEDS-USER-DECISION |
| `code.patch` | `code.workspace.patch` | Applies a diff to a whole in-memory workspace per its own description. (Q11) | NEEDS-USER-DECISION |
| `connection.create` | `graph.connection.create` | Connections belong to the graph (they feed the ingestion pipeline that writes nodes/edges); re-home domain, subject singular (single instance). (Q1) | NEEDS-USER-DECISION |
| `connection.delete` | `graph.connection.delete` | Same re-home; singular (single instance). (Q1) | NEEDS-USER-DECISION |
| `connection.get` | `graph.connection.get` | Same re-home; singular. (Q1) | NEEDS-USER-DECISION |
| `connection.list` | `graph.connections.list` | Same re-home; plural (collection op) — the example given in the brief. (Q1) | NEEDS-USER-DECISION |
| `connection.mappings.get` | `graph.connection_mapping.get` | Re-homed with the rest of the family; compound subject keeps 3 segments; singular (one mapping config). (Q1) | NEEDS-USER-DECISION |
| `connection.mappings.set` | `graph.connection_mapping.set` | Re-homed; singular (sets the one mapping config, even though it holds many field pairs). (Q1) | NEEDS-USER-DECISION |
| `connection.mappings.suggest` | `graph.connection_mapping.suggest` | Re-homed; singular. (Q1) | NEEDS-USER-DECISION |
| `connection.pause` | `graph.connection.pause` | Same re-home; singular. (Q1) | NEEDS-USER-DECISION |
| `connection.preview` | `graph.connection.preview` | Same re-home; singular. (Q1) | NEEDS-USER-DECISION |
| `connection.update` | `graph.connection.update` | Same re-home; singular. (Q1) | NEEDS-USER-DECISION |
| `conversation.archive` | `chat.conversation.archive` | conversation.* and chat.* both name message-thread concepts; merge conversation under the chat domain so there is one home for chat/thread capabilities. (Q2) | NEEDS-USER-DECISION |
| `conversation.attachment.add` | `chat.conversation_attachment.add` | Merge into chat domain; compound subject. (Q2) | NEEDS-USER-DECISION |
| `conversation.chat` | `chat.conversation.post_message` | Description ("Post a message to a conversation") looks like a near-duplicate of chat.message.send — flag for a dedup decision, not just a rename. (Q2) | NEEDS-USER-DECISION |
| `conversation.delete` | `chat.conversation.delete` | Merge into chat domain. (Q2) | NEEDS-USER-DECISION |
| `conversation.export` | `chat.conversation.export` | Merge into chat domain. (Q2) | NEEDS-USER-DECISION |
| `conversation.files.list` | `chat.conversation_files.list` | Merge into chat domain; already-plural subject kept. (Q2) | NEEDS-USER-DECISION |
| `conversation.list` | `chat.conversations.list` | Merge into chat domain; plural (collection op). (Q2) | NEEDS-USER-DECISION |
| `conversation.purge` | `chat.conversations.purge` | Merge into chat domain; plural — purges every archived conversation the caller owns, i.e. a bulk/collection op. (Q2) | NEEDS-USER-DECISION |
| `conversation.rename` | `chat.conversation.rename` | Merge into chat domain. (Q2) | NEEDS-USER-DECISION |
| `document.create` | `asset.document.create` | Content-generation consolidation under `asset`. (Q9) | NEEDS-USER-DECISION |
| `document.generate` | `asset.document.generate` | Same consolidation — note document.create and document.generate may overlap; verify before executing. (Q9) | NEEDS-USER-DECISION |
| `document.list` | `asset.documents.list` | Same consolidation; plural. (Q9) | NEEDS-USER-DECISION |
| `document.pdf.create` | `asset.document_pdf.create` | Same consolidation; compound subject to distinguish from generic document.create. (Q9) | NEEDS-USER-DECISION |
| `document.read` | `asset.document.read` | Same consolidation. (Q9) | NEEDS-USER-DECISION |
| `environment.create` | `workspace.environment.create` | Environments are workspace-scoped deploy configs; re-home under workspace, singular. (Q3) | NEEDS-USER-DECISION |
| `environment.delete` | `workspace.environment.delete` | Same re-home; singular. (Q3) | NEEDS-USER-DECISION |
| `environment.get` | `workspace.environment.get` | Same re-home; singular. (Q3) | NEEDS-USER-DECISION |
| `environment.list` | `workspace.environments.list` | Same re-home; plural (collection op). (Q3) | NEEDS-USER-DECISION |
| `environment.set_default` | `workspace.environment.set_default` | Same re-home; singular. (Q3) | NEEDS-USER-DECISION |
| `environment.update` | `workspace.environment.update` | Same re-home; singular. (Q3) | NEEDS-USER-DECISION |
| `eval.dataset.list` | `eval.datasets.list` | Same plurality rule. | mechanical |
| `eval.run.status` | `eval.run.get_status` | Clears ADR-022 grandfather entry; compound verb avoids colliding with the existing eval.run.get (which gets the whole run, not just its status). | mechanical |
| `form.fill` | `browser.form.fill` | "Generatively fill... page-level form fields" — this is the same page-interaction family as browser.*; re-home under browser, subject=form. (Q13, adjacent) | NEEDS-USER-DECISION |
| `graph.cypher` | `graph.query.run` | Executes a raw or NL-translated Cypher query; subject=query avoids collision with graph.node.*. (Q12) | NEEDS-USER-DECISION |
| `graph.export` | `graph.subgraph.export` | Own description: "Export a workspace subgraph" — subject explicitly named. | mechanical |
| `graph.ingest` | `graph.entities.ingest` | Own description: "Extract entities and relationships from text and commit them" — subject=entities, plural (extracts many). | mechanical |
| `graph.node.list` | `graph.nodes.list` | Same plurality rule; only the .list variant changes — graph.node.get/delete/upsert/search stay singular (single-instance ops). | mechanical |
| `graph.search` | `graph.embedding.search` | Explicitly distinct from graph.node.search (lexical) per its own description — this is embedding/vector search across the whole graph; needs a subject that isn't `node`. (Q12) | NEEDS-USER-DECISION |
| `graph.stats` | `graph.metrics.get` | Parallels the noun-terminal fix applied elsewhere (repo.metrics, integration.metrics) — subject=metrics, explicit get verb. | mechanical |
| `image.analyze` | `asset.image.analyze` | Content-generation consolidation. (Q9) | NEEDS-USER-DECISION |
| `image.create` | `asset.image.create` | Same consolidation. (Q9) | NEEDS-USER-DECISION |
| `image.generate` | `asset.image.generate` | Same consolidation. (Q9) | NEEDS-USER-DECISION |
| `image.list` | `asset.images.list` | Same consolidation; plural. (Q9) | NEEDS-USER-DECISION |
| `integration.configure` | `plugin.instance.configure` | integration.* appears to duplicate plugin.org.* (both do installed-capability CRUD); propose merging under plugin with subject `instance` for the installed record — verify before executing. (Q7) | NEEDS-USER-DECISION |
| `integration.delete` | `plugin.instance.delete` | Same merge. (Q7) | NEEDS-USER-DECISION |
| `integration.get` | `plugin.instance.get` | Same merge. (Q7) | NEEDS-USER-DECISION |
| `integration.install` | `plugin.instance.install` | Same merge — check for literal duplication with plugin.org.install before executing. (Q7) | NEEDS-USER-DECISION |
| `integration.list` | `plugin.instances.list` | Same merge; plural. (Q7) | NEEDS-USER-DECISION |
| `integration.metrics` | `plugin.instance.metrics` | Same merge; also a noun-terminal action — consider plugin.instance.get_metrics. (Q7) | NEEDS-USER-DECISION |
| `integration.sync` | `plugin.instance.sync` | Same merge. (Q7) | NEEDS-USER-DECISION |
| `markdown.generate` | `asset.markdown.generate` | Content-generation consolidation. (Q9) | NEEDS-USER-DECISION |
| `mermaid.generate` | `asset.mermaid.generate` | Same consolidation. (Q9) | NEEDS-USER-DECISION |
| `notification.list` | `user.notifications.list` | Notifications are addressed to a user ("for the calling user"); re-home under user (which already owns user.preferences.*); plural. (Q5) | NEEDS-USER-DECISION |
| `notification.mark` | `user.notification.mark` | Same re-home; singular (marks one notification). (Q5) | NEEDS-USER-DECISION |
| `ontology.neighbors` | `graph.ontology.list_neighbors` | ontology.* is graph traversal (CLAUDE.md: "the ontology.* graph query layer"); re-home under graph, subject=ontology, verb folded to a compound since "neighbors" is a noun, not a verb. (Q6) | NEEDS-USER-DECISION |
| `ontology.query` | `graph.ontology.query` | Same re-home; "query" is already a valid verb. (Q6) | NEEDS-USER-DECISION |
| `org.create` | `platform.org.create` | org is the top of the tenancy tree with no larger owning entity in-repo; introduces a new `platform` domain as the account-level root so org.create isn't self-referential (org.org.create). (Q4) | NEEDS-USER-DECISION |
| `org.list` | `platform.orgs.list` | Same; plural (collection op). (Q4) | NEEDS-USER-DECISION |
| `plugin.org.install` | `plugin.org_install.create` | Subject is currently the SCOPE (org) not the entity acted on (the installed-plugin record); rename subject to org_install so create/list/delete read naturally. (Q10) | NEEDS-USER-DECISION |
| `plugin.org.install_bulk` | `plugin.org_install.create_bulk` | Same family fix; compound verb. (Q10) | NEEDS-USER-DECISION |
| `plugin.org.list` | `plugin.org_installs.list` | Same family fix; plural. (Q10) | NEEDS-USER-DECISION |
| `plugin.org.set_enabled` | `plugin.org_install.set_enabled` | Same family fix. (Q10) | NEEDS-USER-DECISION |
| `plugin.org.uninstall` | `plugin.org_install.delete` | Same family fix — or keep verb `uninstall` (already valid) as plugin.org_install.uninstall; pick one. (Q10) | NEEDS-USER-DECISION |
| `plugin.registry.list` | `plugin.registries.list` | Description confirms this lists multiple named MCP registries — plural subject is the correct mechanical fix (not a scope-as-subject issue like the Q10 rows). | mechanical |
| `plugin.version.list` | `plugin.versions.list` | Same plurality rule. | mechanical |
| `plugin.workspace.set_enabled` | `plugin.workspace_install.set_enabled` | Same family fix, workspace-scoped variant. (Q10) | NEEDS-USER-DECISION |
| `repo.branch.create` | `graph.repo_branch.create` | Re-homed with the family; compound subject. (Q1) | NEEDS-USER-DECISION |
| `repo.ci.status` | `graph.repo_ci.get_status` | Re-homed AND clears the ADR-022 grandfather entry (noun-terminal status→get_status). (Q1) | NEEDS-USER-DECISION |
| `repo.configure` | `graph.repo.configure` | repo.configure's own description says it "Specializes connection.configure for code repository connectors" — repos are graph-feeding connections; re-home alongside connection.*. (Q1) | NEEDS-USER-DECISION |
| `repo.create` | `graph.repo.create` | Same re-home. (Q1) | NEEDS-USER-DECISION |
| `repo.file.put` | `graph.repo_file.put` | Re-homed; compound subject. (Q1) | NEEDS-USER-DECISION |
| `repo.fork` | `graph.repo.fork` | Same re-home. (Q1) | NEEDS-USER-DECISION |
| `repo.metrics` | `graph.repo.metrics` | Same re-home; also a noun-terminal action — consider graph.repo.get_metrics. (Q1) | NEEDS-USER-DECISION |
| `repo.pause` | `graph.repo.pause` | Same re-home. (Q1) | NEEDS-USER-DECISION |
| `repo.pr.diff` | `graph.repo_pr.diff` | Re-homed; compound subject. (Q1) | NEEDS-USER-DECISION |
| `repo.pr.get` | `graph.repo_pr.get` | Re-homed; compound subject. (Q1) | NEEDS-USER-DECISION |
| `repo.pr.open` | `graph.repo_pr.open` | Re-homed; compound subject. (Q1) | NEEDS-USER-DECISION |
| `repo.resume` | `graph.repo.resume` | Same re-home. (Q1) | NEEDS-USER-DECISION |
| `repo.sync` | `graph.repo.sync` | Same re-home. (Q1) | NEEDS-USER-DECISION |
| `research.swarm.status` | `research.swarm.get_status` | Clears ADR-022 grandfather entry using its own suggested fix. | mechanical |
| `schema.chat` | `schema.definition.chat` | Root schema.* ops act on the workspace's schema definition, paralleling agent.definition.* / (proposed) skill.definition.*; subject=definition. (Q14) | NEEDS-USER-DECISION |
| `schema.delete` | `schema.definition.delete` | Same family fix. (Q14) | NEEDS-USER-DECISION |
| `schema.export` | `schema.definition.export` | Same family fix. (Q14) | NEEDS-USER-DECISION |
| `schema.list` | `schema.definitions.list` | Same family fix; plural — flag whether multiple schema definitions genuinely exist per workspace or this is really a singleton/template list (in which case a different subject may be needed). (Q14) | NEEDS-USER-DECISION |
| `schema.recommend` | `schema.definition.recommend` | Same family fix. (Q14) | NEEDS-USER-DECISION |
| `schema.reconcile.status` | `schema.reconcile.get_status` | Clears ADR-022 grandfather entry using its own suggested fix. | mechanical |
| `schema.registry.config` | `schema.registry_config.get` | Clears ADR-022 grandfather entry; renamed to avoid colliding with the existing schema.registry.get capability (also present). | NEEDS-USER-DECISION |
| `schema.setup` | `schema.definition.setup` | Same family fix. (Q14) | NEEDS-USER-DECISION |
| `schema.toggle` | `schema.definition.toggle` | Same family fix. (Q14) | NEEDS-USER-DECISION |
| `schema.validate.node` | `schema.node.validate` | Clears ADR-022 grandfather entry (action-in-middle fix, its own suggestion); no collision with schema.node.* (none currently exists). | mechanical |
| `schema.validate.relationship` | `schema.relationship.validate` | Clears ADR-022 grandfather entry; no collision with schema.relationship.upsert/delete (different verb). | mechanical |
| `schema.version.list` | `schema.versions.list` | Same plurality rule. | mechanical |
| `secret.export` | `secret.environment.export` | Exports the WHOLE resolved secret set for an environment (not one key); subject=environment. (Q16) | NEEDS-USER-DECISION |
| `secret.import_env` | `secret.environment.import_env` | Same — imports a whole .env payload into an environment's secret set. (Q16) | NEEDS-USER-DECISION |
| `secret.key.list` | `secret.keys.list` | Same plurality rule. | mechanical |
| `secret.reveal` | `secret.value.reveal` | Reveals ONE secret's plaintext — matches the existing singular subject already used by secret.value.set/unset. (Q16) | NEEDS-USER-DECISION |
| `semantic.edge.list` | `semantic.edges.list` | Same plurality rule. | mechanical |
| `semantic.relationship.list` | `semantic.relationships.list` | Same plurality rule. | mechanical |
| `skill.author` | `skill.definition.author` | Root skill.* CRUD acts on the base skill entity (distinct from skill.version.* and skill.workspace.*, which already have their own subjects); mirrors the existing agent.definition.* shape exactly. | mechanical |
| `skill.create` | `skill.definition.create` | Same family fix, same precedent. | mechanical |
| `skill.draft` | `skill.definition.draft` | Same family fix. | mechanical |
| `skill.edit` | `skill.definition.edit` | Same family fix. | mechanical |
| `skill.enable` | `skill.definition.enable` | Same family fix. | mechanical |
| `skill.export` | `skill.definition.export` | Same family fix. | mechanical |
| `skill.version.list` | `skill.versions.list` | Same plurality rule. | mechanical |
| `skill.workspace.install` | `skill.workspace_install.create` | Same "scope as subject" family fix applied to skills. (Q10) | NEEDS-USER-DECISION |
| `skill.workspace.list` | `skill.workspace_installs.list` | Same family fix; plural. (Q10) | NEEDS-USER-DECISION |
| `svg.generate` | `asset.svg.generate` | Content-generation consolidation. (Q9) | NEEDS-USER-DECISION |
| `system.install.instructions` | `system.install_instructions.get` | Clears ADR-022 grandfather entry using its own suggested fix. | mechanical |
| `telemetry.error.cluster` | `telemetry.error_cluster.list` | Clears ADR-022 grandfather entry using its own suggested fix. | mechanical |
| `video.generate` | `asset.video.generate` | Content-generation consolidation. (Q9) | NEEDS-USER-DECISION |
| `web.fetch` | `web.page.fetch` | Fetches a URL's content as markdown — subject=page. (Q13) | NEEDS-USER-DECISION |
| `web.search` | `web.query.search` | Searches the web for a query string — subject=query, a judgment call since "web" itself reads as the implicit object. (Q13) | NEEDS-USER-DECISION |
| `workflow.cancel` | `workflow.run.cancel` | Mirrors the run-subject shape; cancels the run. | mechanical |
| `workflow.run` | `workflow.run.start` | Mirrors the existing eval.run.* shape (eval.run.start/get) exactly — subject=run (the workflow-run entity), action=start. | mechanical |
| `workflow.status` | `workflow.run.get` | Mirrors eval.run.get. | mechanical |
| `workspace.create` | `org.workspace.create` | A workspace belongs to an org (org already owns org.member.*, org.settings.*); re-home, singular. (Q3) | NEEDS-USER-DECISION |
| `workspace.list` | `org.workspaces.list` | Same re-home; plural (collection op). (Q3) | NEEDS-USER-DECISION |
| `workspace.member.list` | `workspace.members.list` | Same plurality rule. | mechanical |

## Execution notes (for whoever runs this after user sign-off)

1. Answer every numbered question above; where a family has an accepted alternative subject/domain name, substitute it consistently across every row tagged with that question number.
2. Every rename adds `aliases: [<oldName>]` to the contract per ADR-022 §6 / ADR-024 §6 — never drop the old name outright.
3. Renaming a contract touches its file name (contract, route, MCP tool file names follow the capability name by convention per CLAUDE.md), the API route registration, the MCP tool registration, `docs/capabilities/*.md`, and any hard-coded string references (`grep -rn '"<oldName>"'` across `apps/`, `packages/`, `docs/capabilities/`).
4. After the renames land, retire the `GRANDFATHER` map in `tools/scripts/check-naming.mjs` (should be empty) and flip `check-naming.mjs`'s `NAME_RE` enforcement live in `pnpm check:contracts` / `pnpm check:naming` (the proposed revision in this same PR already implements the exactly-3-segment rule — it just isn't wired to fail CI until execution is complete).
5. Verify with `pnpm check:manifest --json` and `pnpm check:contracts` after each batch of renames, not just at the end.
