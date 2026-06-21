# Spec: handlers-automation-workflow

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: automation.{create,update,enable,disable,list,trigger}.ts, workflow.{run,cancel,status}.ts, research.swarm.{start,status}.ts
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Automation creation requires authenticated user
<!-- id: automationCreateHandler.requiresUserId -->
<!-- entities: User, Automation, Playbook, PlaybookTrigger -->
<!-- enforced: automation.create.ts:automationCreateHandler() -->
<!-- test: automation.create.test.ts:rejects when no userId -->

Handler SHALL reject automation.create when no userId is present in the capability context.

#### Scenario: API call with no authenticated user
<!-- test: automation.create.test.ts:rejects when no userId -->
- **WHEN** automationCreateHandler is invoked with ctx.userId = null
- **THEN** throws error "automation.create requires an authenticated user"

---

### Requirement: Automation creation validates trigger configuration
<!-- id: automationCreateHandler.validateTriggerConfig -->
<!-- entities: Automation, PlaybookTrigger -->
<!-- enforced: automation.create.ts:automationCreateHandler() -->

For event-type triggers, entityType and eventType are both required. For schedule-type triggers, cronExpression is required.

#### Scenario: Event trigger missing entityType
- **WHEN** triggerType = "event" and triggerConfig.entityType is omitted
- **THEN** throws error "automation.create: triggerType='event' requires triggerConfig.entityType and triggerConfig.eventType"

#### Scenario: Schedule trigger missing cronExpression
- **WHEN** triggerType = "schedule" and triggerConfig.cronExpression is omitted
- **THEN** throws error "automation.create: triggerType='schedule' requires triggerConfig.cronExpression"

#### Scenario: Valid event trigger
- **WHEN** triggerType = "event" with entityType and eventType provided
- **THEN** validation passes and playbook is created

---

### Requirement: Automation creation status depends on human origin and enabled flag
<!-- id: automationCreateHandler.statusFromOrigin -->
<!-- entities: Automation, PlaybookTrigger, Playbook -->
<!-- enforced: automation.create.ts:automationCreateHandler() -->
<!-- test: automation.create.test.ts:happy path -->

Playbook status is "active" only if the trigger is human-origin (api/app surface without messageId) AND input.enabled is true. Otherwise status is "draft".

#### Scenario: Human API call with enabled=true
- **WHEN** surface = "api", messageId is null, input.enabled = true
- **THEN** playbook.status = "active" and trigger.isEnabled = true

#### Scenario: Human API call with enabled=false
- **WHEN** surface = "api", messageId is null, input.enabled = false
- **THEN** playbook.status = "draft" and trigger.isEnabled = false

#### Scenario: AI-origin call (in-chat agent)
- **WHEN** surface = "app" but messageId is non-null, input.enabled = true
- **THEN** playbook.status = "draft" and trigger.isEnabled = false (AI-origin always disabled)

---

### Requirement: Automation creation generates playbook shell and version
<!-- id: automationCreateHandler.createPlaybook -->
<!-- entities: Playbook, PlaybookVersion, PlaybookStep, PlaybookTrigger -->
<!-- enforced: automation.create.ts:automationCreateHandler() -->
<!-- test: automation.create.test.ts:inserts playbook and version -->

Handler SHALL insert a playbook row with name/slug/description and status based on humanOrigin+enabled, insert a playbookVersion (v1, published), link the version as activeVersionId, and insert the trigger scoped to org+workspace.

#### Scenario: Automation created with steps
- **WHEN** input.steps = [{name: "Approve", stepType: "human_input", config: {...}}]
- **THEN** playbook, version, and step rows are inserted; trigger row references playbookId and has isEnabled set

#### Scenario: Automation created with no steps
- **WHEN** input.steps = []
- **THEN** a default step with name "Run Agent" and stepType "agent" (agentSlug: "qa-chat") is inserted

---

### Requirement: Automation name is converted to slug
<!-- id: automationCreateHandler.slugGeneration -->
<!-- entities: Automation, Playbook -->
<!-- enforced: automation.create.ts:automationCreateHandler() -->

Name is lowercased, non-alphanumeric chars except dash are replaced with dashes, leading/trailing dashes removed, and trimmed to 80 chars. Empty result defaults to "automation".

#### Scenario: Name with spaces and punctuation
- **WHEN** name = "My Awesome Automation!"
- **THEN** slug = "my-awesome-automation"

#### Scenario: Name with only special chars
- **WHEN** name = "***"
- **THEN** slug = "automation"

---

### Requirement: Automation step name is converted to stepKey
<!-- id: automationCreateHandler.stepKeyGeneration -->
<!-- entities: PlaybookStep -->
<!-- enforced: automation.create.ts:toStepKey() -->

Step name is lowercased, non-alphanumeric replaced with underscores, leading/trailing underscores removed, trimmed to 60 chars. Empty result defaults to "step_1".

#### Scenario: Step name with spaces
- **WHEN** step.name = "Fetch Data"
- **THEN** stepKey = "fetch_data"

---

### Requirement: Automation update requires authenticated user
<!-- id: automationUpdateHandler.requiresUserId -->
<!-- entities: User, Automation -->
<!-- enforced: automation.update.ts:automationUpdateHandler() -->

Handler SHALL reject when no userId in context.

#### Scenario: Update with no user
- **WHEN** ctx.userId = null
- **THEN** throws error "automation.update requires an authenticated user"

---

### Requirement: Automation update resolves trigger scoped to tenant
<!-- id: automationUpdateHandler.resolveTrigger -->
<!-- entities: Automation, PlaybookTrigger, Playbook -->
<!-- enforced: automation.update.ts:automationUpdateHandler() -->

Trigger MUST be scoped to orgId and workspaceId. If not found, throw error.

#### Scenario: Automation exists in workspace
- **WHEN** automation_id matches a trigger in this workspace
- **THEN** trigger is loaded for update

#### Scenario: Automation not found
- **WHEN** automation_id does not exist in this workspace
- **THEN** throws error "automation.update: trigger not found: <automation_id>"

---

### Requirement: Automation update is partial and omitted fields unchanged
<!-- id: automationUpdateHandler.partialUpdate -->
<!-- entities: Playbook, PlaybookTrigger -->
<!-- enforced: automation.update.ts:automationUpdateHandler() -->
<!-- test: automation.update.test.ts -->

Only provided fields (name, description, triggerConfig) are updated. Enable/disable is NOT handled here — that is automation.enable/disable's responsibility.

#### Scenario: Update only name
- **WHEN** input = { automation_id, name: "New Name" }, description and triggerConfig omitted
- **THEN** playbook.name is updated, description and trigger.config unchanged

#### Scenario: Update trigger config only
- **WHEN** input = { automation_id, triggerConfig: {...} }, name and description omitted
- **THEN** trigger.config is updated, playbook fields unchanged

---

### Requirement: Automation enable requires authenticated user
<!-- id: automationEnableHandler.requiresUserId -->
<!-- entities: User, Automation -->
<!-- enforced: automation.enable.ts:automationEnableHandler() -->

Handler SHALL reject when no userId in context.

#### Scenario: Enable with no user
- **WHEN** ctx.userId = null
- **THEN** throws error "automation.enable requires an authenticated user"

---

### Requirement: Automation enable atomically sets trigger and playbook
<!-- id: automationEnableHandler.atomicEnable -->
<!-- entities: Automation, PlaybookTrigger, Playbook -->
<!-- enforced: automation.enable.ts:automationEnableHandler() -->
<!-- test: automation.enable.test.ts:trigger enabled -->

Handler SHALL set trigger.isEnabled = true and playbook.status = "active" in a single transaction.

#### Scenario: Enable automation
- **WHEN** automation_id exists and trigger.isEnabled is currently false
- **THEN** trigger.isEnabled set to true and playbook.status set to "active"

#### Scenario: Enable nonexistent automation
- **WHEN** automation_id does not exist in workspace
- **THEN** throws error "automation.enable: trigger not found: <automation_id>"

---

### Requirement: Automation disable atomically sets trigger and playbook
<!-- id: automationDisableHandler.atomicDisable -->
<!-- entities: Automation, PlaybookTrigger, Playbook -->
<!-- enforced: automation.disable.ts:automationDisableHandler() -->

Handler SHALL set trigger.isEnabled = false and playbook.status = "draft" in a single transaction.

#### Scenario: Disable automation
- **WHEN** automation_id exists and trigger.isEnabled is currently true
- **THEN** trigger.isEnabled set to false and playbook.status set to "draft"

---

### Requirement: Automation disable requires authenticated user
<!-- id: automationDisableHandler.requiresUserId -->
<!-- entities: User, Automation -->
<!-- enforced: automation.disable.ts:automationDisableHandler() -->

Handler SHALL reject when no userId in context.

#### Scenario: Disable with no user
- **WHEN** ctx.userId = null
- **THEN** throws error "automation.disable requires an authenticated user"

---

### Requirement: Automation list requires authenticated user
<!-- id: automationListHandler.requiresUserId -->
<!-- entities: User, Automation -->
<!-- enforced: automation.list.ts:automationListHandler() -->

Handler SHALL reject when no userId in context.

#### Scenario: List with no user
- **WHEN** ctx.userId = null
- **THEN** throws error "automation.list requires an authenticated user"

---

### Requirement: Automation list returns workspace automations ordered by creation
<!-- id: automationListHandler.listWorkspaceAutomations -->
<!-- entities: Automation, PlaybookTrigger, Playbook -->
<!-- enforced: automation.list.ts:automationListHandler() -->
<!-- test: automation.list.test.ts -->

List SHALL query playbookTriggers scoped to org+workspace, join with non-deleted playbooks, order by trigger.createdAt DESC, and return status based on trigger.isEnabled.

#### Scenario: List automations in workspace
- **WHEN** user calls automation.list in their workspace
- **THEN** returns array of {id, name, status, triggerType, triggers} ordered newest-first

#### Scenario: No automations exist
- **WHEN** workspace has no triggers
- **THEN** returns empty array

---

### Requirement: Automation trigger requires authenticated user
<!-- id: automationTriggerHandler.requiresUserId -->
<!-- entities: User, Automation -->
<!-- enforced: automation.trigger.ts:automationTriggerHandler() -->

Handler SHALL reject when no userId in context.

#### Scenario: Trigger with no user
- **WHEN** ctx.userId = null
- **THEN** throws error "automation.trigger requires an authenticated user"

---

### Requirement: Automation trigger only fires enabled automations
<!-- id: automationTriggerHandler.enabledOnly -->
<!-- entities: Automation, PlaybookTrigger, Playbook, PlaybookRun -->
<!-- enforced: automation.trigger.ts:automationTriggerHandler() -->

Trigger query includes filter isEnabled = true. If disabled, throw "trigger not found".

#### Scenario: Fire enabled automation
- **WHEN** trigger.isEnabled = true
- **THEN** run is created and event is dispatched

#### Scenario: Fire disabled automation
- **WHEN** trigger.isEnabled = false
- **THEN** throws error "automation.trigger: trigger not found: <automation_id>"

---

### Requirement: Automation trigger creates run and dispatches executor
<!-- id: automationTriggerHandler.createRunAndDispatch -->
<!-- entities: Automation, PlaybookTrigger, PlaybookRun, Playbook -->
<!-- enforced: automation.trigger.ts:automationTriggerHandler() -->
<!-- test: automation.trigger.test.ts:inserts run and fires event -->

Handler SHALL load playbook's activeVersionId, use pinnedVersionId if set (otherwise activeVersionId), insert run with status "pending", and dispatch "playbook/run.execute" event.

#### Scenario: Trigger automation with payload
- **WHEN** input = {automation_id, payload: {key: "value"}}
- **THEN** playbookRun inserted with status="pending", input=payload, and executor event dispatched

#### Scenario: Trigger with pinned version
- **WHEN** trigger.pinnedVersionId is non-null
- **THEN** run uses pinnedVersionId instead of playbook.activeVersionId

---

### Requirement: Workflow run requires authenticated user
<!-- id: workflowRunHandler.requiresUserId -->
<!-- entities: User, AgentExecution -->
<!-- enforced: workflow.run.ts:workflowRunHandler() -->

Handler SHALL reject when no userId in context.

#### Scenario: Run with no user
- **WHEN** ctx.userId = null
- **THEN** throws error "workflow.run requires an authenticated user"

---

### Requirement: Workflow run creates execution and dispatches supervisor
<!-- id: workflowRunHandler.createExecution -->
<!-- entities: AgentExecution -->
<!-- enforced: workflow.run.ts:workflowRunHandler() -->
<!-- test: workflow.run.test.ts:inserts and fires event -->

Handler SHALL insert agentExecution with status="planning", originType="workflow.run", originId=userId, and dispatch "agent/workflow.supervisor.start" event with maxParallelism and maxTasksGuard.

#### Scenario: Run workflow with goal
- **WHEN** input = {goal: "Research AI trends", outputFormat: "json", maxParallelism: 50}
- **THEN** agentExecution row inserted with status="planning" and supervisor event dispatched

#### Scenario: Default values applied
- **WHEN** outputFormat and maxParallelism omitted
- **THEN** outputFormat defaults to "json", maxParallelism defaults to 50

#### Scenario: Title derived from goal
- **WHEN** input.title is omitted, goal is provided
- **THEN** inputPayload.title = goal.slice(0, 200)

---

### Invariant: Workflow maximum task guard enforces limit
<!-- entities: AgentExecution -->
<!-- enforced: workflow.run.ts:MAX_TASKS_PER_WORKFLOW -->

AgentExecution workflows SHALL NOT exceed 500 parallel tasks. Supervisor receives maxTasksGuard=500 as a hard ceiling.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Workflow cancel idempotent when already terminal
<!-- id: workflowCancelHandler.terminalIdempotent -->
<!-- entities: AgentExecution -->
<!-- enforced: workflow.cancel.ts:workflowCancelHandler() -->

If execution status is "completed" or "cancelled", returns {cancelled: false}. No error, no state change.

#### Scenario: Cancel completed workflow
- **WHEN** execution.status = "completed"
- **THEN** returns {cancelled: false}

#### Scenario: Cancel in-flight workflow
- **WHEN** execution.status = "planning" or "running"
- **THEN** status set to "cancelled", event dispatched, returns {cancelled: true}

---

### Requirement: Workflow cancel resolves by id or publicId
<!-- id: workflowCancelHandler.resolveById -->
<!-- entities: AgentExecution -->
<!-- enforced: workflow.cancel.ts:workflowCancelHandler() -->

Input workflowId is matched against agentExecutions.id OR agentExecutions.publicId. Scoped to org+workspace.

#### Scenario: Cancel by internal id
- **WHEN** input.workflowId = internal execution id
- **THEN** execution is found and cancelled

#### Scenario: Cancel by public id
- **WHEN** input.workflowId = public id (wfr_...)
- **THEN** execution is found and cancelled

#### Scenario: Workflow not found
- **WHEN** workflowId matches neither id nor publicId in this workspace
- **THEN** throws error "workflow not found: <workflowId>"

---

### Requirement: Workflow status returns execution and step details
<!-- id: workflowStatusHandler.returnExecutionStatus -->
<!-- entities: AgentExecution, AgentExecutionStep -->
<!-- enforced: workflow.status.ts:workflowStatusHandler() -->

Handler SHALL load execution by id/publicId scoped to org+workspace, query steps ordered by stepNumber, and return workflow + tasks array with status, timestamps, and result payload.

#### Scenario: Query in-flight workflow
- **WHEN** execution exists and steps have mixed statuses
- **THEN** returns workflow with totalTasks, completedTasks, failedTasks counts and tasks array

#### Scenario: Workflow not found
- **WHEN** workflowId does not exist in workspace
- **THEN** throws error "workflow not found: <workflowId>"

---

### Requirement: Workflow status maps input and output payloads
<!-- id: workflowStatusHandler.payloadMapping -->
<!-- entities: AgentExecution, AgentExecutionStep -->
<!-- enforced: workflow.status.ts:workflowStatusHandler() -->

ExecutionStep.inputPayload and outputPayload are treated as arbitrary JSON objects. Fields title/goal are extracted from inputPayload if present.

#### Scenario: Step with custom input/output
- **WHEN** step.inputPayload = {title: "Find market size", goal: "..."}
- **THEN** returned task.title = "Find market size" and task.outputJson = step.outputPayload

---

### Requirement: Research swarm start generates queries by depth
<!-- id: researchSwarmStartHandler.queryDepth -->
<!-- entities: ResearchSwarm -->
<!-- enforced: research.swarm.start.ts:researchSwarmStartHandler() -->

Depth "shallow" → 3 queries, "medium" → 8 queries, "deep" → 15 queries. Default 8 if unknown depth.

#### Scenario: Shallow research
- **WHEN** input.depth = "shallow"
- **THEN** generateObjectFor called with prompt mentioning "3 diverse queries"

#### Scenario: Deep research
- **WHEN** input.depth = "deep"
- **THEN** generateObjectFor called with prompt mentioning "15 diverse queries"

---

### Requirement: Research swarm start dispatches fanout and uses dispatchId as swarmId
<!-- id: researchSwarmStartHandler.fanoutDispatch -->
<!-- entities: ResearchSwarm -->
<!-- enforced: research.swarm.start.ts:researchSwarmStartHandler() -->

Queries are generated, then agent.subagent.dispatch is invoked with tasks mapped to web.search calls. The returned dispatchId becomes the swarmId (NOT a random UUID).

#### Scenario: Start swarm research
- **WHEN** input = {topic: "AI trends", depth: "medium", maxParallel: 5, searchDepth: "basic"}
- **THEN** generateObjectFor is called, agent.subagent.dispatch invoked with 8 tasks, swarmId = dispatchResult.dispatchId

#### Scenario: Swarm response structure
- **WHEN** swarm dispatched successfully
- **THEN** returns {swarmId, dispatchId, status: "running", estimatedTasks}

---

### Requirement: Research swarm status polls via agent.subagent.aggregate
<!-- id: researchSwarmStatusHandler.aggregatePolling -->
<!-- entities: ResearchSwarm -->
<!-- enforced: research.swarm.status.ts:researchSwarmStatusHandler() -->

Input swarmId is the dispatchId from a prior swarm.start. Handler delegates to agent.subagent.aggregate (fanoutId = swarmId) without timeoutMs override.

#### Scenario: Poll running swarm
- **WHEN** swarmId matches a fanout dispatchId and tasks are in-flight
- **THEN** aggregate returns status and children; swarm status mapped to "running"

#### Scenario: Swarm completed
- **WHEN** aggregate status = "completed" or "partial"
- **THEN** swarm status mapped to "complete"

---

### Requirement: Research swarm status maps aggregate status to swarm status
<!-- id: researchSwarmStatusHandler.statusMapping -->
<!-- entities: ResearchSwarm -->
<!-- enforced: research.swarm.status.ts:mapStatus() -->

"completed" → "complete", "partial" → "complete", "failed" → "failed", "timed_out" → "failed", else "running".

#### Scenario: All tasks completed
- **WHEN** aggregateStatus = "completed"
- **THEN** mapStatus returns "complete"

#### Scenario: Some tasks failed
- **WHEN** aggregateStatus = "timed_out"
- **THEN** mapStatus returns "failed"

---

### Requirement: Research swarm status extracts web search results from children
<!-- id: researchSwarmStatusHandler.resultMapping -->
<!-- entities: ResearchSwarm -->
<!-- enforced: research.swarm.status.ts:mapChildrenToResults() -->

Each child run is a web.search execution. Handler extracts query from input, results array from output, and maps to {query, resultCount, hits} with defensive null-checks.

#### Scenario: Web search child with results
- **WHEN** child.input = {query: "typescript"}, child.output = {results: [{title: "TS Docs", url: "...", content: "..."}], totalResults: 100}
- **THEN** result = {query: "typescript", resultCount: 100, hits: [{title: "TS Docs", url: "...", snippet: "..."}]}

#### Scenario: Malformed child payload
- **WHEN** child.output is not an object or results is not an array
- **THEN** hit is skipped; result includes query only if non-empty

---

### Invariant: PlaybookTrigger scoping enforces tenant isolation
<!-- entities: PlaybookTrigger, Automation -->
<!-- enforced: automation.{create,update,enable,disable,list,trigger}.ts -->

All queries and updates of playbookTriggers MUST include orgId and workspaceId conditions. Cross-tenant access is impossible even if publicIds are leaked.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: AgentExecution scoping enforces tenant isolation
<!-- entities: AgentExecution, Workflow -->
<!-- enforced: workflow.{run,cancel,status}.ts -->

All queries and updates of agentExecutions MUST include orgId and workspaceId conditions.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: All handlers require userId before mutation
<!-- entities: User -->
<!-- enforced: automation.{create,update,enable,disable,list,trigger}.ts, workflow.{run,cancel,status}.ts -->

Before any INSERT/UPDATE, all handlers check ctx.userId. Read-only operations may relax this, but mutation always requires authentication.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: automation.trigger does not check if user has permission to run the specific automation (e.g., ownership or role-based access); it only requires userId to exist. Verify authorization policy is enforced elsewhere (e.g., in the kernel, in the contract middleware). -->

<!-- uncertainty: workflow.cancel does not require userId check (unlike automation handlers). Verify if this is intentional and whether cancellation should be user-gated. -->

<!-- uncertainty: automation.create supports multiple trigger types (event, schedule, api) but only event and schedule have inline validation. Type "api" has no triggerConfig validation. Clarify if empty config is valid or if api triggers should require validation. -->
