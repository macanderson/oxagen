# Workflows

## Chat Turn (Synchronous)

```mermaid
sequenceDiagram
    participant U as User
    participant App as apps/app SSE route
    participant K as kernel.invoke
    participant Agent as packages/agent
    participant LLM as LLM Provider
    participant Tools as Capability Handlers

    U->>App: POST /api/v1/chat/stream (message + attachments)
    App->>K: invoke("chat.message.send", input, ctx)
    K->>Agent: streamAgentReply(ctx, messages, tools)
    Agent->>LLM: stream (system prompt + history + tool defs)
    loop LLM reasoning loop
        LLM-->>Agent: tool_call
        Agent->>K: invoke(capabilityName, args, ctx)
        K-->>Agent: result
        Agent->>LLM: tool_result
    end
    LLM-->>Agent: final text
    Agent-->>App: stream events (text_delta, tool_call, tool_result, done)
    App-->>U: SSE stream
    Agent->>Neo4j: recordExecutionInGraph (fire-and-forget)
```

## Ingestion Pipeline

Triggered by webhook or scheduled sync. Runs as an Inngest function.

```mermaid
flowchart LR
    A["Source Event\n(webhook / poll)"] --> B["verifyWebhook\n(HMAC signature)"]
    B --> C["normalizeRecord\n(connector-specific)"]
    C --> D["dedup resolve\n(fuzzy entity match)"]
    D --> E["upsertEntityNode\n(Neo4j)"]
    E --> F["embedEntity\n(vector embedding)"]
    F --> G["inferSemanticEdges\n(LLM inference)"]
    G --> H["upsertInferredEdges\n(confidence + evidence)"]
```

Connectors: GitHub, Linear, Slack, Google (7 services), Salesforce, Microsoft, Zoom, custom-webhook, custom-sql.

## IAM Resolution

Invoked on every `kernel.invoke()` call when `_iamCheckFn` is registered.

```mermaid
flowchart TD
    A["capability + ctx + defaultEffect"] --> B["fetchAuthz(db, orgId, workspaceId, userId)"]
    B --> C["resolve(input, authz)"]
    C --> D{Rule 1: Explicit user grants}
    D -- Match --> OUT
    D -- No match --> E{Rule 2: Role grants}
    E -- Match --> OUT
    E -- No match --> F{Rule 3: Policies with conditions}
    F -- Match + conditions pass --> OUT
    F -- No match --> G{Rule 4-5: Inherited role}
    G -- Match --> OUT
    G -- No match --> H{Rule 6: require_approval?}
    H -- Yes --> AP["create access_request\nreturn pending_approval"]
    H -- No --> I{Rule 8: defaultEffect}
    I --> OUT["outcome: allow | deny"]
    OUT --> J["emitAudit to ClickHouse\n(always, fire-and-forget)"]
```

## Billing Turn Gate

```mermaid
flowchart LR
    A["kernel.invoke()"] --> B{noBillingGate?}
    B -- Yes --> SKIP["skip gate"]
    B -- No --> C["assertOrgCanConsume(orgId)"]
    C --> D{Active subscription?}
    D -- Suspended --> ERR1["BillingSuspendedError"]
    D -- Active --> E{Credit balance > 0?}
    E -- No --> ERR2["InsufficientCreditsError"]
    E -- Yes --> OK["proceed"]
```

## Release Workflow

```mermaid
flowchart LR
    A["pnpm gate\n(local)"] --> B["pnpm release:patch|minor|major"]
    B --> C["bumpVersion (all packages)"]
    C --> D["git commit + tag"]
    D --> E["syncVercel\n(deploy all Vercel projects)"]
    E --> F["publishCliToNpm"]
    F --> G["generateNotes + writeNotes"]
    G --> H["Linear ticket update"]
```

## GDPR Data Erasure

```mermaid
flowchart LR
    A["privacy.data.erase\ncapability"] --> B["Insert erasure_request\n(grace period delay)"]
    B --> C["Inngest: privacy.erasure.execute"]
    C --> D["Delete Postgres rows\n(user across all schemas)"]
    D --> E["Delete Neo4j memories"]
    E --> F["Delete Blob assets"]
    F --> G["ClickHouse soft-delete\n(append tombstone event)"]
```

## Playbook (Automation) Execution

```mermaid
flowchart TD
    A["Trigger Event\n(webhook / schedule / manual)"] --> B["playbook.trigger.match\n(evaluatePropertyConditions)"]
    B -- Match --> C["Inngest: playbook.run.execute"]
    C --> D["Step 1"]
    D --> E["Step 2...N\n(sequential or parallel)"]
    E --> F["computeEventHash\n(idempotency)"]
    F --> G["kernel.invoke each step action"]
```

## Subagent Fanout

```mermaid
flowchart LR
    A["agent.subagent.dispatch\n(parent agent)"] --> B["dispatchFanout\n(Inngest events per child)"]
    B --> C["N × agent.execute-subagent\n(parallel Inngest jobs)"]
    C --> D["agent.subagent.aggregate\n(merge outputs)"]
    D --> E["deriveFanoutStatus\n(complete | partial | failed)"]
```

## Agent Execution Telemetry (Four-Store Sync)

Every agent invocation — regardless of dispatch origin (chat, event trigger, scheduled job, MCP request, or workflow run) — is logged to a unified `agent.agent_executions` record with nested `agent_execution_steps` and `agent_tool_calls`. The record is written synchronously to Postgres (billing source of truth), then mirrored asynchronously to Neo4j (graph lineage) and ClickHouse (time-series analytics).

```mermaid
flowchart TD
    O["Dispatch Origin\n(chat | event_trigger | scheduled_job | mcp_request | workflow_run)"] --> I["invoke()\n(AI SDK boundary)"]
    I --> S["Execution complete\n(seal telemetry: tokens, latency, cost, tool calls)"]
    S --> PG["Postgres (SYNC, ACID)\ninsertExecutionRecord\nsynced_to_graph_at = NULL"]
    PG --> N["Neo4j (ASYNC)\nagent.sync-execution-to-graph (Inngest)\nexec node + edges to agent/origin/entities\nSET synced_to_graph_at = NOW()"]
    PG --> CH["ClickHouse (ASYNC, fire-and-forget)\nexecution_events row\npartitioned monthly, TTL 2y"]
    N -. "retry ≤24h on failure, then alert" .-> N
```

| Store | Freshness | Consistency | Use case |
|---|---|---|---|
| Postgres | Immediate | ACID | Billing, status, cost reconciliation |
| Neo4j | 5–30 sec | Eventual | Graph queries, entity discovery, lineage |
| ClickHouse | 5–10 min | Eventual | Trends, aggregates, immutable audit |

**`workflow_runs` vs `agent_executions`** — orthogonal, not redundant. `agent.workflow_runs` is the orchestration **container** (plan structure, progress: totalTasks/completedTasks/failedTasks). `agent.agent_executions` is the per-invocation **telemetry log**, linked back via `origin_type = 'workflow_run'` + `origin_id`. Query "all executions for a run" by joining on those two columns.

> Source: `docs/specs/agent-execution/{design-spec,implementation-plan,workflow-runs-clarification}.md`. The design spec also covers the dead-schema sunset (dropping `execution.*`, `workflow.playbooks`, `event.triggers`, `integration.connections`, `content.documents`, `agent.tools`).

## OAuth Plugin Credential Flow

```mermaid
sequenceDiagram
    User->>App: Install plugin
    App->>Plugin: plugin.org.install
    App->>OAuth: redirectToAuthorization (PKCE)
    OAuth-->>App: callback with code
    App->>Plugin: saveTokens (encrypted via KMS envelope)
    Plugin-->>App: credential stored
    App->>Ingestion: create connection
```
