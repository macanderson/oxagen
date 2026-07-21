# Spec: inngest-agent-execution

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: adapter.ts, inngest.ts, create-function.ts, functions.ts, index.ts, agent.aggregate-fanout.ts, agent.execute-subagent.ts, agent.background-task.execute.ts, agent.video-render.ts, agent.workflow.supervisor.ts, agent.workflow.task.execute.ts
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Inngest lazy initialization on first use
<!-- id: inngest.getInngest -->
<!-- entities: InngestClient -->
<!-- enforced: inngest.ts:getInngest() -->

The Inngest client SHALL be initialized lazily on first `.send()` or `.createFunction()` call, not at module import time. This enables Next.js build-time page-data collection to succeed even when Inngest env vars are not injected. In production (NODE_ENV=production), INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY MUST be non-empty strings; their absence throws validation error.

#### Scenario: dev-time import without env vars
- **WHEN** the inngest module is imported during Next.js build (NODE_ENV != production)
- **THEN** module evaluation succeeds; no error is raised

#### Scenario: prod initialization requires credentials
- **WHEN** NODE_ENV=production and either INNGEST_EVENT_KEY or INNGEST_SIGNING_KEY is missing/empty
- **THEN** getInngest() throws with "INNGEST_EVENT_KEY required when NODE_ENV=production" or similar message

#### Scenario: first send() triggers initialization
- **WHEN** inngest.send() is called for the first time
- **THEN** getInngest() is invoked, credentials are validated, and the Inngest instance is created; subsequent calls reuse the singleton

---

### Requirement: Event-driven subagent fanout execution
<!-- id: agentExecuteSubagent.agentExecuteSubagent -->
<!-- entities: subagentRuns, subagentFanouts, message -->
<!-- enforced: agent.execute-subagent.ts:agentExecuteSubagent -->
<!-- depends_on: Inngest lazy initialization on first use -->

When `agent/subagent.dispatch` event is received, the system SHALL load all child subagent runs for the fanout, mark the fanout as running, execute each child's capability via kernel.invoke() in isolated step.run() blocks, update each run's status and output/error, and emit `agent/subagent.fanout.completed` when all children are terminal.

#### Scenario: fanout depth exceeds limit
- **WHEN** the event includes depth > MAX_FANOUT_DEPTH (3)
- **THEN** the function returns {fanoutId, completed: 0, status: "failed", depthExceeded: true} without dispatching any children

#### Scenario: successful fanout execution
- **WHEN** fanout has 3 child runs and all 3 invoke() calls succeed
- **THEN** each child's subagent_runs row is updated to status="completed" with outputPayload; fanout_status becomes "completed"; event "agent/subagent.fanout.completed" is emitted with completedChildren=3

#### Scenario: partial fanout completion
- **WHEN** fanout has 5 child runs, 3 succeed and 2 fail
- **THEN** successful runs are marked status="completed", failed runs are marked status="failed" with errorReason; fanout_status is "partial" (never "failed" due to CHECK constraint); event shows status="partial", completedChildren=3

#### Scenario: all children fail
- **WHEN** fanout has 3 children and all invoke() calls throw
- **THEN** all 3 subagent_runs rows are marked status="failed"; fanout status is stored as "partial" (CHECK constraint); deriveFanoutStatus() returns "failed" for aggregation

#### Scenario: child invoke() failure is isolated
- **WHEN** child #2 raises an error while children #1 and #3 are in-flight
- **THEN** child #2's step.run() catches the error, updates its row to status="failed", and returns false; children #1 and #3 complete independently; fanout proceeds to finalization

---

### Requirement: Subagent fanout completion telemetry
<!-- id: agentExecuteSubagent.emit-completion-telemetry -->
<!-- entities: ClickHouse events, subagentFanouts -->
<!-- enforced: agent.execute-subagent.ts:emit-completion-telemetry step -->

After a fanout's children are all terminal, the system SHALL write one event to ClickHouse (insertEvents) with event_type="agent.subagent.fanout.completed" containing fanoutId, status, totalChildren, completedChildren, and depth. This write is fire-and-forget; failure does NOT fail the fanout run.

#### Scenario: telemetry write succeeds
- **WHEN** insertEvents() completes normally after fanout finalization
- **THEN** ClickHouse receives the event and the Inngest function continues

#### Scenario: telemetry write fails
- **WHEN** insertEvents() throws an error
- **THEN** the error is caught and logged as "insertEvents failed — fanout completion telemetry loss"; the Inngest function continues and succeeds

---

### Requirement: Fanout child tool_invocations metering
<!-- id: agentExecuteSubagent.child-N -->
<!-- entities: tool_invocations, subagentRuns -->
<!-- enforced: agent.execute-subagent.ts:child-N step -->

For each child in a fanout, after invoke() completes (success or failure), the system SHALL write a tool_invocations row with invocation_id, org_id, workspace_id, capability_name, message_id, parent_message_id=fanoutId, status, latency_ms, error_class (on failure), and surface="runner". Telemetry write failure is logged but does not fail the run.

#### Scenario: successful child invocation metering
- **WHEN** a child's invoke() call succeeds
- **THEN** insertToolInvocation() is called with status="completed", error_class=null, latency_ms=(end - start)

#### Scenario: failed child invocation metering
- **WHEN** a child's invoke() call throws
- **THEN** insertToolInvocation() is called with status="failed", error_class=error.name or "UnknownError"

---

### Requirement: Subagent fanout aggregation with durable wait
<!-- id: agentAggregateFanout.agentAggregateFanout -->
<!-- entities: subagentFanouts, subagentRuns, message -->
<!-- enforced: agent.aggregate-fanout.ts:agentAggregateFanout -->
<!-- triggers: Subagent fanout completion telemetry -->

When `agent/subagent.aggregate.requested` event is received, the system SHALL call step.waitForEvent() to park until `agent/subagent.fanout.completed` arrives for the same fanoutId. The wait has a clamped timeout (default 5 min, max 30 min). After wait completes or times out, the system reads the merged aggregate snapshot via agent.subagent.aggregate capability and emits `agent/subagent.aggregated` with honest status.

#### Scenario: fanout completes before timeout
- **WHEN** agent/subagent.fanout.completed event arrives within the wait window
- **THEN** step.waitForEvent() returns the completion event, read-aggregate is invoked, and agent/subagent.aggregated is emitted with timedOut=false

#### Scenario: wait times out
- **WHEN** no agent/subagent.fanout.completed event arrives within the clamped timeout
- **THEN** step.waitForEvent() returns null, in-progress snapshot is read via agent.subagent.aggregate, agent/subagent.aggregated is emitted with timedOut=true, and a warn log is produced

#### Scenario: timeout clamping
- **WHEN** timeoutMs is provided as 1000 (< 0 after min clamp) or 2 hours (> 30 min max)
- **THEN** timeout is clamped to [0, 1800000 ms]; default 300000 ms (5 min) if not provided

---

### Requirement: Background task execution with cancellation
<!-- id: agentBackgroundTaskExecute.agentBackgroundTaskExecute -->
<!-- entities: backgroundTasks, message -->
<!-- enforced: agent.background-task.execute.ts:agentBackgroundTaskExecute -->

When `agent/task.background.start` event is received, the system SHALL mark the task as running, invoke the named capability from the payload's `capability` field, update the row with resultPayload on success or failureReason on error, and write tool_invocations metering. The function never retries (retries: 0) and respects cancellation via `agent/task.background.cancel` event (matching taskId and orgId).

#### Scenario: successful background task
- **WHEN** event has payload.capability="foo.bar" and invoke succeeds with output {x: 1}
- **THEN** backgroundTasks row is marked status="completed" with resultPayload={x: 1}; tool_invocations is written with status="completed"

#### Scenario: missing capability field
- **WHEN** event.data.payload has no "capability" key
- **THEN** invoke() throws "background task payload missing 'capability'"; task is marked status="failed" with failureReason="background task payload missing 'capability'"

#### Scenario: background task cancellation
- **WHEN** task is running and `agent/task.background.cancel` event arrives with matching taskId and orgId
- **THEN** Inngest cancels the in-flight execution; the task row's status remains unchanged but the execution is terminated

#### Scenario: task invoke failure
- **WHEN** the named capability raises an error
- **THEN** backgroundTasks row is marked status="failed" with failureReason=error.message; tool_invocations shows status="failed", error_class=error.name

---

### Requirement: Workflow supervision with task planning and parallelization
<!-- id: agentWorkflowSupervisor.agentWorkflowSupervisor -->
<!-- entities: agentExecutions, agentExecutionSteps -->
<!-- enforced: agent.workflow.supervisor.ts:agentWorkflowSupervisor -->

When `agent/workflow.supervisor.start` event is received, the system SHALL (1) load the execution; (2) invoke generateObjectFor() to decompose the goal into 2–N tasks (capped by maxTasksGuard or MAX_TASKS_PER_WORKFLOW=500); (3) persist tasks as agentExecutionSteps rows; (4) dispatch task events in batches respecting maxParallelism. Cancellation via `agent/workflow.cancel` event (matching executionId) stops further task dispatch.

#### Scenario: execution not found
- **WHEN** execution row does not exist
- **THEN** returns {status: "failed", reason: "execution not found"} and logs error

#### Scenario: plan generation and task creation
- **WHEN** LLM generates 5 tasks for the goal "research AI trends"
- **THEN** agentExecutionSteps rows are inserted with status="pending", stepNumber=0–4, stepType="research"; execution is marked status="running" with plan persisted

#### Scenario: batch dispatch with concurrency limit
- **WHEN** 10 tasks are generated with maxParallelism=3
- **THEN** tasks are dispatched in 4 batches: [0–2], [3–5], [6–8], [9]; each batch is a separate step.run() call

#### Scenario: task limit enforcement
- **WHEN** maxTasksGuard=200 and LLM returns 300 tasks
- **THEN** only first 200 tasks are used; remaining 100 are discarded before insertion

#### Scenario: workflow cancellation
- **WHEN** `agent/workflow.cancel` event arrives with matching executionId
- **THEN** Inngest cancels the supervisor execution; any in-flight batch dispatch is interrupted

---

### Requirement: Workflow task execution with step-wise progress tracking
<!-- id: agentWorkflowTaskExecute.agentWorkflowTaskExecute -->
<!-- entities: agentExecutionSteps, agentExecutions -->
<!-- enforced: agent.workflow.task.execute.ts:agentWorkflowTaskExecute -->
<!-- depends_on: Workflow supervision with task planning and parallelization -->

When `agent/workflow.task.execute` event is received, the system SHALL mark the step as running, invoke generateObjectFor() with the task goal, persist the output, and check if all sibling steps are terminal. If all steps are terminal, the execution is marked completed or failed based on whether any step succeeded.

#### Scenario: single task execution succeeds
- **WHEN** step is pending and generateObjectFor() returns {summary: "...", data: {...}, sources: [...]}
- **THEN** agentExecutionSteps row is marked status="completed" with outputPayload={summary, data, sources}; tool_invocations shows status="completed"

#### Scenario: task execution fails
- **WHEN** generateObjectFor() throws
- **THEN** step is marked status="failed" with failureReason=error.message; tool_invocations shows status="failed", error_class=error.name; error is rethrown

#### Scenario: final step completion triggers execution finalization
- **WHEN** this is the 5th of 5 steps and all 5 are now completed or failed
- **THEN** agentExecutions row is marked status="completed" (if any step succeeded) or "failed" (if all failed)

#### Scenario: partial execution progress (not terminal)
- **WHEN** 2 of 5 steps are completed
- **THEN** execution status remains "running"; no finalization occurs

---

### Requirement: Video generation and asset upload pipeline
<!-- id: agentVideoRender.agentVideoRender -->
<!-- entities: generatedAssets -->
<!-- enforced: agent.video-render.ts:agentVideoRender -->

When `agent/video.render` event is received, the system SHALL (1) call generateVideoFor() with the video model (resolved from explicit model or mediaTier), (2) upload raw bytes to Vercel Blob with private access, (3) update the generatedAssets row with status="ready" and storage metadata. Video generation is expensive (2–5+ min); retries: 0 and function timeout is 16 minutes (1 minute above generateVideoFor's 15-minute abort).

#### Scenario: video generation and upload succeeds
- **WHEN** generateVideoFor() returns bytes and Uint8Array, storage().put() succeeds
- **THEN** generatedAssets row is marked status="ready" with storageKey, storageUrl, mimeType, sizeBytes; function returns {assetId, status: "ready", storageKey, storageUrl}

#### Scenario: video model selection from tier
- **WHEN** model is not provided but mediaTier="advanced"
- **THEN** selectVideoModel() resolves a tier-appropriate model; generateVideoFor() uses that model

#### Scenario: explicit model overrides tier
- **WHEN** both model="google/veo-3.0-fast-generate-001" and mediaTier="basic" are provided
- **THEN** explicit model is used; mediaTier is ignored

#### Scenario: video generation timeout (15-min AbortController)
- **WHEN** generateVideoFor() fetch does not complete within 15 minutes
- **THEN** AbortController fires, fetch is aborted, error is thrown, and the on-failure handler runs

#### Scenario: on-failure handler marks asset failed
- **WHEN** any step in agentVideoRender throws (e.g., generation timeout or upload failure)
- **THEN** agentVideoRenderOnFailure is triggered; generatedAssets row is marked status="failed" with metadata.failureReason=error message; error is logged

#### Scenario: binary data cannot cross step boundary
- **WHEN** raw Uint8Array is returned from a step.run()
- **THEN** JSON serialization corrupts the bytes (Uint8Array round-trips as index map); generate-and-upload combines generation+upload in one atomic step to avoid this

---

### Requirement: Durable function creation with on-failure companion
<!-- id: createFunction.createFunction -->
<!-- entities: DurableFunction, InngestFunction -->
<!-- enforced: create-function.ts:createFunction() -->

The createFunction() factory SHALL translate an abstract DurableFunctionConfig into one or two Inngest functions: the primary function with the given id, trigger, and handler, plus an optional on-failure companion function (id suffixed with ".on-failure") if config.onFailure is provided. Both are augmented with config and trigger metadata. CRITICAL: the abstract id is stored in config/trigger, never assigned to Inngest's id property (which is a method, not a data field).

#### Scenario: primary function creation
- **WHEN** createFunction({ id: "foo.bar", retries: 1 }, { event: "foo/bar" }, handler) is called
- **THEN** an Inngest function with id "foo.bar" is created and augmented with {config, trigger}; array of length 1 is returned

#### Scenario: on-failure companion creation
- **WHEN** config includes onFailure handler
- **THEN** a second Inngest function with id "foo.bar.on-failure" is created; it listens for "inngest/function.failed" with if="event.data.function_id == 'foo.bar'"; array of length 2 is returned

#### Scenario: wrappedHandler translates NonRetriableError
- **WHEN** the user's handler throws @oxagen/functions NonRetriableError
- **THEN** wrapHandler catches it and rethrows as Inngest's native NonRetriableError; Inngest stops retrying

#### Scenario: step adaptation to StepContext
- **WHEN** the handler receives the Inngest step object
- **THEN** wrapHandler adapts it to the abstract StepContext interface; step.run(), step.sendEvent(), step.waitForEvent(), step.sleep() all work

---

### Requirement: EventClient adapter for durable event sending
<!-- id: createEventClient.createEventClient -->
<!-- entities: EventPayload -->
<!-- enforced: adapter.ts:createEventClient() -->

The createEventClient() adapter SHALL return an EventClient object with a send() method that forwards events to inngest.send(). The event shape (name, data) is structurally compatible; return type matches the abstract contract (Promise<void>).

#### Scenario: send single event
- **WHEN** eventClient.send({name: "foo/bar", data: {x: 1}}) is called
- **THEN** inngest.send() is invoked with the same payload; Promise<void> is returned

#### Scenario: send event batch
- **WHEN** eventClient.send([{name: "a", data: {...}}, {name: "b", data: {...}}]) is called
- **THEN** inngest.send() forwards the array; all events are queued

---

### Invariant: Inngest event registry is source of truth
<!-- entities: Events, agent, chat, stripe, ingestion, playbook, privacy -->
<!-- enforced: inngest.ts:Events type -->

All Inngest events (agent/subagent.dispatch, chat/message.streamed, stripe/subscription.updated, etc.) MUST be registered in the Events record at the top of inngest.ts. Event-name inference at `.createFunction()` call sites flows through EventSchemas and the Events registry; any event not in the registry cannot be typed or dispatched.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Subagent fanout status transitions are monotonic
<!-- entities: subagentFanouts.status -->
<!-- enforced: agent.execute-subagent.ts:finalize step -->

The status column of subagentFanouts SHALL only transition from pending → running → (completed|partial|timed_out). The status column has a CHECK constraint allowing {pending, running, completed, partial, timed_out}, never "failed". An all-children-failed fanout is stored as "partial"; the true "failed" status is computed by agent.subagent.aggregate from per-run counts (completedCount === 0 && anyFailed).

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Tool invocations are fire-and-forget telemetry
<!-- entities: tool_invocations -->
<!-- enforced: agent.execute-subagent.ts, agent.background-task.execute.ts, agent.workflow.task.execute.ts -->

Every invocation of a capability (subagent child, background task, workflow step) MUST write a tool_invocations row for metering. Telemetry write failure SHALL NOT fail the primary operation; failures are logged as "insertToolInvocation failed — telemetry loss" and the function continues.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Database transactions are scoped tightly
<!-- entities: schema, withTenantDb, withSystemDb -->
<!-- enforced: agent.execute-subagent.ts, agent.background-task.execute.ts, agent.workflow.supervisor.ts, agent.workflow.task.execute.ts, agent.video-render.ts -->

Transactions (withTenantDb, withSystemDb blocks) MUST wrap only DB-level operations. Long-running I/O (LLM calls, video generation, file uploads) MUST occur outside the transaction to avoid holding locks. If a capability returns a large result, the persist step runs after invoke() completes, not wrapping it.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: agent.background-task.execute.ts surface and provider fields in tool_invocations are hardcoded to "runner" and "" (empty). Clarify whether these should be derived from the event or context. -->
<!-- uncertainty: agent.video-render.ts telemetry fields (input_size_bytes, output_size_bytes) are hardcoded to 0. Clarify whether the generated video size should be captured or if this is intentional sampling. -->
