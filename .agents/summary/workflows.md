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
