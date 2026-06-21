# Spec: handlers-agent-chat

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: agent.compose.ts, agent.execution.record.ts, agent.subagent.logs.ts, chat.message.send.ts, chat.message.execution.ts, conversation.chat.ts, conversation.list.ts, conversation.rename.ts, conversation.archive.ts, conversation.delete.ts, conversation.purge.ts, conversation.files.list.ts
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Plan multi-step capability chains from a goal
<!-- id: agent.compose.planChain -->
<!-- entities: Capability, PlannedStep -->
<!-- enforced: agent.compose.planChain() -->

The agent.compose handler SHALL plan a sequence of steps to accomplish a goal by querying available agent-surface capabilities, invoking an LLM to decompose the goal into concrete steps with inputs and dependency chains, and validating steps against the capability catalog. Each step's input may reference prior step outputs using `$steps.<id>.<dotpath>` binding syntax. The plan is constrained to a maximum number of steps (typically 10).

#### Scenario: Plan with valid dependencies and bindings
<!-- test: agent.compose test("readPath reads nested dot-paths") -->
- **WHEN** a goal is provided with no context and autoExecute is false
- **THEN** the LLM returns a plan with one or more PlannedStep objects, each with id, capability, rationale, inputJson, and dependsOn array

#### Scenario: Dependency order is validated
<!-- test: agent.compose test("topoSort orders dependencies before dependents") -->
- **WHEN** steps declare dependsOn relationships
- **THEN** executePlan respects topological order and skips steps whose dependencies failed

---

### Requirement: Execute a planned step chain with auto-safety gates
<!-- id: agent.compose.executePlan -->
<!-- entities: PlannedStep, Capability, ComposeStepResult -->
<!-- enforced: agent.compose.executePlan() -->
<!-- depends_on: Plan multi-step capability chains from a goal -->

Execute a topologically-sorted plan by invoking each step's capability through the kernel (which applies IAM, billing, and entitlement gates). Each step's planned input is JSON-parsed and resolved with bindings from prior successful step outputs. Steps with failed dependencies are skipped. Destructive or approval-required capabilities are never auto-executed — they remain planned (status: "skipped" with reason). All three execution flows (success, dependency-blocked, error) return a ComposeStepResult with status, input, output/error, and durationMs.

#### Scenario: Step executes successfully with resolved bindings
<!-- test: agent.compose test("resolveBindings resolves exact-match token to raw value") -->
- **WHEN** a step is ready to execute and prior steps succeeded with outputs
- **THEN** bindings like `$steps.step1.nodeId` are resolved to actual values and passed to invoke()

#### Scenario: Destructive capability is skipped with clear reason
<!-- test: agent.compose test("isSafeToAutoExecute returns false for sensitivity=destructive") -->
- **WHEN** a planned step references a capability with sensitivity="destructive" or agent.requiresApproval=true
- **THEN** the step is marked status="skipped" with error "Capability is destructive or requires approval — not auto-executed."

#### Scenario: Dependent step is skipped when prerequisite fails
- **WHEN** a step's dependency (listed in dependsOn) has status="error" or "skipped"
- **THEN** this step is skipped with error "A prerequisite step did not complete successfully."

#### Scenario: Cyclic plan halts all steps
<!-- test: agent.compose test("topoSort throws on cycle") -->
- **WHEN** planned steps form a dependency cycle (e.g., step1 depends on step2, step2 depends on step1)
- **THEN** topoSort throws and all steps are returned as status="skipped" with error "Plan contains a dependency cycle."

---

### Requirement: Summarize a capability chain outcome for user presentation
<!-- id: agent.compose.summarize -->
<!-- entities: ComposeStepResult -->
<!-- enforced: agent.compose.summarize() -->
<!-- depends_on: Execute a planned step chain with auto-safety gates -->
<!-- triggers: Agent composition returns plan and summary to user -->

After execution (or planning dry-run), an LLM summarizes the step results in 2-4 plain-language sentences, highlighting concrete outcomes (counts, names, ids) and calling out failures. If summary generation fails, fall back to counting successes. The summary is never null — a failure to generate via LLM still returns a best-effort fallback.

#### Scenario: Summary for executed plan
- **WHEN** executed=true and some steps succeeded
- **THEN** summary states what was accomplished and includes concrete result details

#### Scenario: Summary for dry-run plan
- **WHEN** executed=false
- **THEN** summary describes the PROPOSED capability chain (not yet executed)

---

### Requirement: Record complete agent execution with steps and tool calls
<!-- id: agent.execution.record -->
<!-- entities: AgentExecution, AgentExecutionStep, AgentToolCall -->
<!-- enforced: agent.execution.record() -->

The agent.execution.record handler persists a complete agent execution record (root execution, nested steps, tool calls per step) into three related tables (agent_executions, agent_execution_steps, agent_tool_calls) within a single transaction. All tables use workspace_id in their RLS policies for cross-workspace isolation. The handler returns the executionId and createdAt timestamp, which the caller uses for downstream lineage tracking.

#### Scenario: Root execution with steps and tool calls persisted atomically
- **WHEN** input includes agentId, agentVersionId, status, originType, and an array of steps with nested toolCalls
- **THEN** all three inserts (execution, step, toolCall) complete in one transaction and return executionId

#### Scenario: Execution without steps
- **WHEN** input.steps is null or empty array
- **THEN** only the root execution row is inserted; step and toolCall tables remain unchanged

---

### Requirement: Create or join a conversation and persist user message with placeholder assistant message
<!-- id: chat.message.send -->
<!-- entities: Conversation, Message -->
<!-- enforced: chat.message.send() -->

The chat.message.send handler persists the user's message turn in two steps: (1) create a new conversation or validate that the provided conversationId belongs to the calling tenant's org+workspace, (2) insert the user message and an empty assistant message (status: "pending") in the same transaction. The activeLeafMessageId pointer on the conversation is updated to the assistant message row, establishing the active branch for future message trees. A new conversation with a non-empty first message triggers asynchronous title generation (best-effort, failures do not fail the message send).

#### Scenario: New conversation created with first message
<!-- test: chat.message.send test("creates a new conversation when conversationId is null") -->
- **WHEN** input.conversationId is null and content is non-empty
- **THEN** a new conversation row is inserted with status="active", and the user and assistant messages are linked

#### Scenario: Message added to existing conversation
<!-- test: chat.message.send test("skips conversation insert when conversationId provided") -->
- **WHEN** conversationId is provided and belongs to this tenant (verified by orgId scope)
- **THEN** only the two message rows (user + assistant) are inserted; conversation update moves activeLeafMessageId

#### Scenario: Cross-tenant conversation access is blocked
<!-- test: chat.message.send test("throws 'conversation not found in this tenant'") -->
- **WHEN** conversationId is provided but does not belong to this tenant (orgId mismatch)
- **THEN** throw error "conversation not found in this tenant"

#### Scenario: Unauthenticated user is rejected
<!-- test: chat.message.send test("throws when userId is null (unauthenticated request)") -->
- **WHEN** ctx.userId is null
- **THEN** handler logs warning and throws "chat.message.send requires an authenticated user"

---

### Requirement: Record agent execution within a chat message context
<!-- id: chat.message.execution -->
<!-- entities: Message, AgentExecution, AgentExecutionStep, AgentToolCall -->
<!-- enforced: chat.message.execution() -->

The chat.message.execution handler validates that the target message belongs to the current workspace, then records the execution (and all nested steps and tool calls) with originType="chat" and originId set to the message's id. The execution and message metadata updates occur in the same transaction for atomicity. An optional updateMessageMetadata flag allows the caller to emit the executionId and status into the message's metadata JSON.

#### Scenario: Execution recorded with message ownership validated
- **WHEN** messageId belongs to this org+workspace and all execution data is provided
- **THEN** execution inserts (with originType="chat") and message metadata are atomically updated

#### Scenario: Invalid message rejects execution write
- **WHEN** messageId does not exist in this workspace or org
- **THEN** throw error "message not found in this workspace"

---

### Requirement: Delegate conversation.chat to chat.message.send
<!-- id: conversation.chat -->
<!-- entities: Conversation, Message -->
<!-- enforced: conversation.chat() -->

The conversation.chat handler provides a synchronous, non-streaming surface over the chat.message.send capability. It maps the simplified conversation.chat contract (conversation_id, message) to the full chat.message.send shape (conversationId, content, contentBlocks, parentMessageId, branchReason), delegates to chatMessageSendHandler, and projects the result to the public conversation.chat shape (message_id, created_at, author).

#### Scenario: Simplified input delegated to chat.message.send
<!-- test: conversation.chat test("delegates to chatMessageSendHandler with mapped input") -->
- **WHEN** conversation_id and message are provided
- **THEN** chatMessageSendHandler is called with mapped fields and result is projected to message_id/created_at/author

#### Scenario: Unauthenticated request rejected
<!-- test: conversation.chat test("throws when userId is null") -->
- **WHEN** ctx.userId is null
- **THEN** handler throws "conversation.chat requires an authenticated user"

---

### Requirement: List conversations by archive status with cursor pagination
<!-- id: conversation.list -->
<!-- entities: Conversation -->
<!-- enforced: conversation.list() -->

The conversation.list handler returns a paginated list of conversations filtered by archive status (active/archived) and tenant scope. Results are ordered by updatedAt descending. Cursor-based keyset pagination (createdAt < cursor) is supported. The handler respects deletedAt and archivedAt nullability constraints so soft-deleted and archived rows are excluded or included per filter. An extra fetch of limit+1 determines whether a nextCursor exists.

#### Scenario: Active conversations listed with most-recent first
<!-- test: conversation.list test("invokes the query builder with filter=active") -->
- **WHEN** filter="active" is requested
- **THEN** only conversations where archivedAt is null and deletedAt is null are returned, ordered by updatedAt DESC

#### Scenario: Archived conversations listed when requested
<!-- test: conversation.list test("maps archivedAt to ISO string when set") -->
- **WHEN** filter="archived" is requested
- **THEN** only conversations where archivedAt is not null and deletedAt is null are returned

#### Scenario: Cursor pagination determines next page
<!-- test: conversation.list test("returns nextCursor when rows.length > limit") -->
- **WHEN** rows fetched exceeds input.limit
- **THEN** nextCursor is set to the updatedAt of the last visible row and page is sliced to limit

#### Scenario: Last page has no cursor
<!-- test: conversation.list test("returns null nextCursor when rows.length <= limit (last page)") -->
- **WHEN** fetched rows equal or fall short of input.limit
- **THEN** nextCursor is null

---

### Requirement: Rename a single conversation
<!-- id: conversation.rename -->
<!-- entities: Conversation -->
<!-- enforced: conversation.rename() -->

The conversation.rename handler updates the title field of a single conversation identified by publicId, subject to tenant scope and user scope (userId, orgId, workspaceId) constraints. The update is atomic and only succeeds if the conversation exists and belongs to the calling user. Cross-tenant access is blocked by the orgId and workspaceId conditions.

#### Scenario: Conversation title updated successfully
<!-- test: conversation.rename test("returns publicId and title on success") -->
- **WHEN** conversationId (publicId) belongs to this user in this org+workspace
- **THEN** title is updated and publicId + new title are returned

#### Scenario: Conversation not found throws clearly
<!-- test: conversation.rename test("throws 'conversation not found' when update returns no rows") -->
- **WHEN** conversationId does not match any conversation in this user's scope
- **THEN** throw error "conversation.rename: conversation not found"

---

### Requirement: Archive or unarchive multiple conversations
<!-- id: conversation.archive -->
<!-- entities: Conversation -->
<!-- enforced: conversation.archive() -->

The conversation.archive handler bulk-updates multiple conversations' archivedAt and archivedByUserId fields based on the input.archived flag. When archived=true, archivedAt is set to now() and archivedByUserId to the current userId. When archived=false, both are set to null (unarchive). Only conversations that belong to the calling user in their org+workspace and are not already deleted are updated. The handler returns the count of rows affected.

#### Scenario: Conversations archived in bulk
<!-- test: conversation.archive test("returns updated count matching rows affected") -->
- **WHEN** archived=true and multiple conversationIds are provided
- **THEN** all matching conversations are marked archived and updated count is returned

#### Scenario: Conversations unarchived in bulk
<!-- test: conversation.archive test("returns updated count when unarchiving") -->
- **WHEN** archived=false and conversationIds are provided
- **THEN** archivedAt and archivedByUserId are cleared for all matching rows

#### Scenario: No matching rows returns 0
<!-- test: conversation.archive test("returns 0 when no rows match") -->
- **WHEN** conversationIds do not belong to this user or are already deleted
- **THEN** return updated=0

---

### Requirement: Soft-delete conversations by id
<!-- id: conversation.delete -->
<!-- entities: Conversation -->
<!-- enforced: conversation.delete() -->

The conversation.delete handler soft-deletes multiple conversations by setting deletedAt to now() and deletedByUserId to the current userId. Only conversations matching the tenant scope (orgId, workspaceId, userId) and not already deleted are affected. The handler returns the count of rows affected.

#### Scenario: Conversations soft-deleted in bulk
<!-- test: conversation.delete test("returns deleted count matching rows affected") -->
- **WHEN** one or more conversationIds are provided and belong to this user
- **THEN** deletedAt and deletedByUserId are set for all matches and deleted count is returned

#### Scenario: No matching rows returns 0
<!-- test: conversation.delete test("returns 0 when no rows match (already deleted or wrong tenant)") -->
- **WHEN** conversationIds do not match or are already deleted
- **THEN** return deleted=0

---

### Requirement: Purge all archived conversations for a user
<!-- id: conversation.purge -->
<!-- entities: Conversation -->
<!-- enforced: conversation.purge() -->

The conversation.purge handler soft-deletes all conversations belonging to the current user that are marked archived (archivedAt is not null) but not yet deleted (deletedAt is null). No input parameters are required; the handler acts on the calling user's archived conversations in their org+workspace. The return value is the count of purged conversations.

#### Scenario: Archived conversations purged in one call
<!-- test: conversation.purge test("returns deleted count equal to number of archived rows purged") -->
- **WHEN** user has one or more archived conversations
- **THEN** all archived (non-deleted) conversations are soft-deleted and purged count is returned

#### Scenario: No archived conversations to purge
<!-- test: conversation.purge test("returns deleted=0 when there are no archived conversations") -->
- **WHEN** user has no archived conversations
- **THEN** return deleted=0

---

### Requirement: List generated assets within a conversation
<!-- id: conversation.files.list -->
<!-- entities: Conversation, GeneratedAsset -->
<!-- enforced: conversation.files.list() -->

The conversation.files.list handler returns a paginated list of generated assets attached to a conversation. The conversation is resolved by publicId and must belong to the calling user's org+workspace (deletedAt must be null). Assets are filtered by kind (image, video, document, spreadsheet, presentation, pdf, archive) and status="ready". Access-policy filtering is applied in-process: assets with accessPolicy="user" are only visible to their creator, "org" assets are visible to any org member, and "public" assets are visible to all. Cursor-based pagination (createdAt descending) is supported.

#### Scenario: User lists assets in their conversation
<!-- test: conversation.files.list test("maps asset rows to ConversationAssetItem shape") -->
- **WHEN** conversationId belongs to this org+workspace and one or more assets exist with status="ready"
- **THEN** assets are returned with derived name, kind, mimeType, sizeBytes, accessPolicy, and url

#### Scenario: Conversation not found throws clearly
<!-- test: conversation.files.list test("throws when the conversation is not found in org scope") -->
- **WHEN** conversationId does not belong to this org+workspace
- **THEN** throw error "conversation.files.list: conversation not found"

#### Scenario: User-policy assets are access-controlled
<!-- test: conversation.files.list test("includes 'user'-policy assets belonging to the calling user") -->
- **WHEN** asset.accessPolicy="user" and asset.userId matches ctx.userId
- **THEN** asset is included in results

#### Scenario: User-policy assets owned by others are hidden
<!-- test: conversation.files.list test("excludes 'user'-policy assets belonging to a different user") -->
- **WHEN** asset.accessPolicy="user" and asset.userId does not match ctx.userId
- **THEN** asset is excluded from results (filtered in-process after DB scan)

#### Scenario: Org-policy assets are visible to any org member
<!-- test: conversation.files.list test("includes 'org'-policy assets for any org member") -->
- **WHEN** asset.accessPolicy="org"
- **THEN** asset is included in results (orgId scope already verified)

---

### Invariant: All handlers require authenticated user context
<!-- entities: CapabilityContext, Message, Conversation -->
<!-- enforced: chat.message.send(), conversation.chat(), conversation.list(), conversation.rename(), conversation.archive(), conversation.delete(), conversation.purge(), conversation.files.list() -->
<!-- verified_by: chat.message.send test("throws when userId is null"), conversation.chat test("throws when userId is null"), conversation.list test("throws when userId is null"), conversation.rename test("throws when userId is null"), conversation.archive test("throws when userId is null"), conversation.delete test("throws when userId is null"), conversation.purge test("throws when userId is null"), conversation.files.list test("throws when userId is null") -->

Every handler in this capability set SHALL throw an error if ctx.userId is null or undefined. No user-facing operation (message send, conversation list, archive, delete, rename, or files list) is permitted without authentication.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: All conversation operations respect multi-tenant isolation
<!-- entities: Conversation, Message, GeneratedAsset -->
<!-- enforced: chat.message.send(), chat.message.execution(), conversation.list(), conversation.rename(), conversation.archive(), conversation.delete(), conversation.purge(), conversation.files.list() -->

All conversation and message queries and updates use `withTenantDb` and include both orgId and workspaceId in their WHERE clauses. Cross-tenant lookup is impossible: attempting to access a conversation with mismatched orgId or workspaceId results in no rows and an error ("conversation not found"). This applies to all user-facing operations.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: All conversation operations respect user-scope constraints
<!-- entities: Conversation -->
<!-- enforced: conversation.list(), conversation.rename(), conversation.archive(), conversation.delete(), conversation.purge(), conversation.files.list() -->

Conversation queries and updates include userId as a WHERE condition alongside orgId and workspaceId. A user cannot see, modify, or delete another user's conversations, even within the same workspace.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Deleted conversations are excluded from all visible lists and updates
<!-- entities: Conversation -->
<!-- enforced: conversation.list(), conversation.rename(), conversation.archive(), conversation.delete(), conversation.files.list() -->

All conversation queries include `isNull(schema.conversations.deletedAt)` or explicit `deletedAt` checks. Soft-deleted conversations (deletedAt is not null) are never returned to the user and never modified by subsequent operations.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: New conversations start with active status and null title
<!-- entities: Conversation -->
<!-- enforced: chat.message.send() -->

When a new conversation is created (conversationId is null), the insert sets status="active" and title=null. Title is populated asynchronously via LLM generation only for new conversations with non-empty first messages.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Assistant message placeholder is created for every user turn
<!-- entities: Message -->
<!-- enforced: chat.message.send(), conversation.chat() -->

Every user message insert is immediately followed by an assistant message insert with role="assistant", content="", contentBlocks=[], and metadata={ status: "pending" }. The activeLeafMessageId pointer on the conversation is updated to this assistant row, establishing the active branch for the next turn.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Generated asset access policy is enforced per-user for 'user' scope
<!-- entities: GeneratedAsset -->
<!-- enforced: conversation.files.list() -->
<!-- verified_by: conversation.files.list test("excludes 'user'-policy assets belonging to a different user") -->

Assets with accessPolicy="user" are filtered in-process after the indexed DB scan: only assets where asset.userId === ctx.userId are included in results. This filtering is not delegated to SQL to avoid exposing asset metadata to unauthorized users.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Plan execution respects topological ordering of steps
<!-- entities: PlannedStep -->
<!-- enforced: agent.compose.executePlan() -->
<!-- verified_by: agent.compose test("topoSort orders dependencies before dependents") -->

Steps are executed in topological order derived from dependsOn edges. If a cycle is detected, topoSort throws and all steps are marked skipped. Steps with failed or skipped dependencies are never executed.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Binding resolution preserves value types for exact-match tokens
<!-- entities: PlannedStep -->
<!-- enforced: agent.compose.resolveBindings() -->
<!-- verified_by: agent.compose test("resolveBindings resolves exact-match token to raw value") -->

When a planned step's input contains a string that exactly matches `$steps.<id>.<path>` (no surrounding text), the resolved value preserves its original type (object, array, number, boolean). When the token is embedded in a larger string, the value is string-interpolated.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Destructive and approval-required capabilities are never auto-executed
<!-- entities: Capability -->
<!-- enforced: agent.compose.executePlan() -->
<!-- verified_by: agent.compose test("isSafeToAutoExecute returns false for destructive") -->

Any capability with sensitivity="destructive" or agent.requiresApproval=true is marked status="skipped" during execution with clear reason, never actually invoked. Only safe (read-only or reversible) capabilities are auto-executed.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Execution records are atomic across root, steps, and tool calls
<!-- entities: AgentExecution, AgentExecutionStep, AgentToolCall -->
<!-- enforced: agent.execution.record(), chat.message.execution() -->

All inserts for a single execution (root record, steps, tool calls) occur within a single transaction. Partial writes are impossible; either all three tables are written together or none are.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Conversation title generation is asynchronous and non-blocking
<!-- entities: Conversation -->
<!-- enforced: chat.message.send() -->

When a new conversation receives its first message, an LLM title-generation task is spawned asynchronously outside the message-send transaction. If title generation fails, the error is logged but does not fail the message send. The message send always returns successfully regardless of title generation outcome.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: agent.subagent.logs handler's markdown rendering and asset persistence are read-only side effects (building and storing a document). The Requirement covers the transformation from aggregate data to markdown and the asset write, but the buildLogMarkdown function is a pure export and the asset persistence is delegated to persistGeneratedAsset, so the behavior is surfaced via the returned asset metadata (assetId, publicId, url). Actual markdown generation and query/result formatting are implementation details rather than contract boundaries. -->
