# Dead Pages & UI Coverage Gaps

> **Superseded for launch (2026-07-21).** This generated 2026-06-25 audit is
> retained as historical evidence. Its capability inventory predates the launch
> pruning; generic graph mutation, raw Cypher, and automatic execution/file lineage
> are no longer supported product surfaces. Do not use the rows below as a current
> implementation backlog.

> Generated: 2026-06-25. Audit of `apps/app` pages that show preview/mock data
> without live backend wiring, plus backend capabilities that lack app UI.

---

## Part 1 — Preview/Mock Pages (no live data)

Every page listed below renders hardcoded mock data and/or displays a "Preview"
disclaimer. None perform `withTenantDb`, `invoke()`, or server-action calls.

### Workspace scope (`/:org/:workspace/`)

| # | Route | Section | Indicator | Recommendation |
|---|---|---|---|---|
| 1 | `automation/triggers` | Automation → Triggers | `MOCK_TRIGGERS`, "Preview" pill | **Build** — `agent.trigger.*` capabilities are fully implemented |
| 2 | `automation/playbooks` | Automation → Playbooks | `MOCK_PLAYBOOKS`, "Preview" pill | **Build** — no backend yet; design preview for workflow orchestration |
| 3 | `automation/event-sources` | Automation → Events | `MOCK_EVENTS`, "Preview" pill | **Build** — no backend yet; event subscription design preview |
| 4 | `activity/approvals` | Activity → Approvals | `MOCK_APPROVALS`, "Preview" pill | **Build** — `agent.approval.resolve` capability exists |
| 5 | `activity/audit` | Activity → Audit | `MOCK_AUDIT`, "Preview" pill | **Build** — `audit.log.query` capability exists; org-level is live |
| 6 | `knowledge/memories` | Knowledge → Memories | `MOCK_MEMORIES`, "Preview" pill | **Build** — `agent.memory.recall` + `agent.memory.write` exist |
| 7 | `settings/model-keys` | Settings → Model Keys | `MOCK_MODEL_KEYS`, "Preview" pill | **Build** — needs backend capability + frontend |

### Org scope (`/:org/`)

| # | Route | Section | Indicator | Recommendation |
|---|---|---|---|---|
| 8 | `access/grants` | Access → Grants | `MOCK_GRANTS`, "OXA-XXXX" | **Build** — IAM kernel has grant resolution; needs list/manage UI |
| 9 | `access/policies` | Access → Policies | `MOCK_POLICIES`, "OXA-XXXX" | **Build** — policy CRUD capabilities needed |
| 10 | `access/principals` | Access → Principals | `MOCK_PRINCIPALS`, "OXA-XXXX" | **Build** — unify user/service/agent identities |
| 11 | `access/requests` | Access → Requests | `MOCK_REQUESTS`, "OXA-XXXX" | **Build** — JIT access request flow needed |
| 12 | `access/roles` | Access → Roles | `MOCK_ROLES`, "Preview" pill | **Build** — roles are seeded at org creation but no role CRUD exists |
| 13 | `security/sso` | Security → SSO | "Coming soon" badge | **Hold** — major feature; honest placeholder |
| 14 | `security/scim` | Security → SCIM | "Coming soon" badge | **Hold** — major feature; honest placeholder |
| 15 | `developer/webhooks` | Developer → Webhooks | "Coming soon" text | **Hold** — no backend; planned feature |
| 16 | `developer/docs` | Developer → Docs | Inline `API_ENDPOINTS` array | **Kill** — static link hub; redirect to docs site |

### Summary

- **16 mock/preview pages total**
- Build: 12 (backend exists or is straightforward)
- Hold: 3 (SSO, SCIM, Webhooks — major planned features)
- Kill: 1 (Developer Docs — redundant with docs site)

---

## Part 2 — Backend Capabilities Without App UI

Capabilities that are registered in `packages/handlers/`, exposed on `"api"`,
but have no corresponding app page, server action, or UI control in `apps/app`.

### High priority (user-facing; should have UI)

| # | Capability | Purpose | Gap |
|---|---|---|---|
| 1 | `api.key.create` | Create a new API key | Developer/Tokens page lists keys but has no "Create" button |
| 2 | `api.key.revoke` | Revoke an API key | No revoke action in UI |
| 3 | `api.key.rotate` | Rotate an API key | No rotate action in UI |
| 4 | `audit.log.query` | Structured audit event query | Workspace audit page is a mock; should wire to this |
| 5 | `agent.memory.recall` | Read agent memory records | Knowledge/Memories page is a mock |
| 6 | `agent.memory.write` | Write agent memory records | Same as above |
| 7 | `agent.trigger.list` | List automation triggers | Automation/Triggers page is a mock |
| 8 | `agent.trigger.create` | Create automation trigger | Same |
| 9 | `agent.trigger.update` | Update automation trigger | Same |
| 10 | `agent.trigger.delete` | Delete automation trigger | Same |
| 11 | `agent.approval.resolve` | Resolve pending approval | Activity/Approvals page is a mock |
| 12 | `repo.configure` | Configure git repo connection | No repo management UI exists anywhere |
| 13 | `repo.sync` | Trigger repo sync | Same |
| 14 | `repo.pause` / `repo.resume` | Pause/resume repo connector | Same |
| 15 | `repo.metrics` | View repo connector metrics | Same |
| 16 | `automation.enable` / `automation.disable` | Toggle automation rules | No toggle exists in mock pages |
| 17 | `connection.pause` | Pause a data connection | Sources page shows connections but pause may not be wired |
| 18 | `skill.create` | Create a skill | Skills settings lists installed skills but no "create" flow |
| 19 | `org.settings.read` / `org.settings.write` | Org settings via capability | Org general uses direct DB reads, not this capability |
| 20 | `workspace.settings.read` / `workspace.settings.write` | Workspace settings via capability | Same — direct DB reads instead |

### Lower priority (agent/programmatic — UI optional)

| # | Capability | Purpose | Why UI is optional |
|---|---|---|---|
| 1 | `workflow.run` / `workflow.status` / `workflow.cancel` | Workflow orchestration | Dispatched by agents; status visible in Activity/Runs |
| 2 | `image.create` / `image.list` / `image.analyze` | Image operations | Agent/chat-facing; results appear in conversation |
| 3 | `document.create` / `document.list` / `document.read` | Document CRUD | Generated via chat; no standalone gallery needed |
| 4 | `video.generate` | Video generation | Triggered from chat |
| 5 | `research.swarm.start` / `research.swarm.status` | Multi-agent research | Launched from conversation |
| 6 | `graph.cypher` | Raw Cypher execution | Admin/agent internal |
| 7 | `ontology.query` / `ontology.neighbors` | Knowledge graph queries | Used by semantic inference pipeline |
| 8 | `agent.code.execute` | Sandbox code execution | Agent runtime primitive |
| 9 | `skill.author` | AI-assisted skill authoring | CLI/agent workflow |

---

## Recommended build order

Priority is based on: existing backend readiness, user visibility, and
dependency chains.

1. **API Key CRUD** — wire create/revoke/rotate into developer/tokens (backend done)
2. **Workspace audit** — wire mock to `audit.log.query` (backend done)
3. **Agent triggers** — wire mock to `agent.trigger.*` (backend done)
4. **Approvals queue** — wire mock to `agent.approval.resolve` (backend done)
5. **Agent memories** — wire mock to `agent.memory.*` (backend done)
6. **Repository connections** — build new page under knowledge/sources or settings
7. **Access grants/roles/policies** — build alongside IAM CRUD capabilities
8. **Model keys** — need backend capability first, then wire
9. **Playbooks + event sources** — need backend capabilities first
10. **Kill developer/docs** — replace with redirect to docs.oxagen.sh
