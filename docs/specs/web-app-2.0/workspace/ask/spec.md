---
# Ask

- **Route:** `/{orgSlug}/{workspaceSlug}/ask`
- **Nav location:** workspace → primary → Ask (the front door / default landing surface)
- **Priority:** P1
- **Disposition vs today:** Keep

## Purpose
The canonical conversation surface where a user talks to an agent — asks a question, watches it plan, approve/deny tool calls, stream a grounded answer, and spin off background work. It is the most heavily used and most fully wired page in the app today and is the primary place the graph-grounding and governance stories become visible to end users.

## Primary user & jobs-to-be-done
- **Primary user:** any workspace member operating or building agents
- **JTBD:**
  - Ask a question and get a streamed, cited answer grounded in the knowledge graph
  - Review and approve/deny agent plans, tool consents, and MCP consent prompts inline
  - Manage conversations (list, rename, archive, delete, purge) without losing context
  - Start, monitor, and cancel long-running background tasks from the same thread
  - Set per-user budget policy and pick model/agent/repo/env options before running

## Functionality
- Conversation list sidebar (create/rename/archive/delete/purge).
- Main thread: streamed assistant turns via SSE; renders tool calls, approval prompts, MCP consent prompts, plan-approval cards inline.
- `?agent=` query param binds a specific published agent to the session.
- Compose bar: model picker, code-mode repo/env selectors, budget indicator, attachment support.
- Answer citations: graph nodes/edges referenced in an answer render as `NodeRef` chips (never raw UUIDs) — hovering/clicking opens the property popover per the citation convention.
- Legacy `/chat?c=<id>` route 302s into `/ask` preserving the conversation id.

## Capabilities invoked
- `agent.approval.resolve` (`resolve_approval`) — approve/deny an agent action.
- `agent.mcp_consent.resolve` (`resolve_mcp_consent`) — approve/deny an MCP tool consent prompt.
- `agent.plan.approve` (`approve_plan`) — approve a proposed multi-step plan.
- `agent.background_task.start` / `.read` / `.cancel` (`start_background_task` / `get_background_task` / `cancel_background_task`) — long-running task lifecycle.
- `budget.policy.read` / `.write` (`get_user_budget` / `update_user_budget`) — per-user spend guardrail.
- `agent.definition.get` (`get_agent_def`) — resolve `?agent=` binding.
- `conversation.list` / `.rename` / `.archive` / `.delete` / `.purge` — conversation lifecycle.
- `agent.memory.write` (`write_memory`) — persist durable memory from the turn.
- `graph.ingest` (`ingest_graph`) — ingest new facts surfaced mid-conversation.
- `video.generate` (`generate_video`) — generative-UI video output when requested.

## Data sources
Postgres (conversations, budget policy, agent definitions); ClickHouse (turn/tool metering emitted through `invoke()`); Neo4j (memory writes, graph ingest, cited node/edge lookups); SSE stream from `POST /api/v1/chat/stream` consumed by `use-tool-stream.ts`.

## States
- **Empty:** no conversations yet — compose bar front and center with a blank-canvas prompt.
- **Loading:** parallel fail-open loads (conversation list, prefs, model defaults, MCP servers, budget, code-mode options, agent options) — no section blocks another.
- **Error:** any one fail-open load degrades gracefully (default applied) rather than blocking the compose bar; stream errors surface inline in the thread.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/ask/page.tsx` is COMPLETE — renders the shared `ConversationPage` with 6 bound server actions and the parallel fail-open loads above. Keep as-is; this is the reference implementation for how other pages should degrade gracefully.

## Vision alignment
Directly the graph-grounding pillar (cited answers via `NodeRef`) and the governance/accountability chain (inline approval/consent/plan resolution) — P1 because it is the front door and the most complete expression of the wedge today.
