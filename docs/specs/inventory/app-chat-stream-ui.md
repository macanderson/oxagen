# Spec: app-chat-stream-ui

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: use-tool-stream.ts, stream-event-types.ts, chat-shell-client.tsx, chat-component-registry.tsx, activity-timeline.tsx, intercept-form-fill.ts, message-bubble.tsx
> Last verified: 2026-06-20 (commit 2f628504)

---

## Overview

The chat stream surface consumes SSE events from `POST /api/v1/chat/stream` and renders live tool calls, reasoning, plans, approvals, consents, memory operations, and subagent fanouts in true stream order via an activity timeline. A single transport (no ai/rsc). Generative UI: structured output components dispatched from a registry via render directives. Stream consumption pauses at approval/consent gates until user resolution or incoming *-resolved events unblock the loop. Text and tool events interleave; the reducer maintains an ordered timeline key list so reasoning, tool calls, and text segments appear in exact stream-arrival order, not grouped by type.

---

### Requirement: Stream event reducer accumulates SSE state
<!-- id: use-tool-stream.reducer -->
<!-- entities: StreamEvent, ToolStreamState, LiveToolCall, LiveReasoning, LiveApproval, LiveConsent, LivePlan, LiveFanout, LiveMemoryRecall, LiveMemoryWrite, LiveComponent, LiveTextSegment -->
<!-- enforced: use-tool-stream.reducer() -->

The reducer accepts stream events one at a time and accumulates mutable state keyed by entity ID. Each event type maps to one or more state updates: text accumulates into the open segment (or opens a fresh one if text was preceded by a tool/reasoning/approval event); reasoning segments track text + status + duration; tool calls track input (both partial during composition and parsed on start), status, output, stdout/stderr, error reason, and duration; approvals and consents track input preview and resolution. The timeline order list (first-appearance keys in `<kind>:<id>` format) is updated idempotently on every non-text event, breaking the active text segment so subsequent text opens a new segment. Once a segment/tool/reasoning/approval/consent/etc. is added to order, it is never removed, even if an incoming event updates its state.

#### Scenario: text accumulates into open segment
<!-- test: use-tool-stream.test.ts:textAccumulates -->
- **WHEN** a `text` event arrives with `messageId` M and text "hello"
- **THEN** `state.messages[M]` is created with `{ messageId: M, text: "hello" }` and `state.textSegments[<segment-key>]` with `{ key: <segment-key>, messageId: M, text: "hello" }`, where `<segment-key>` is either the `activeTextKey` (if one is open) or a fresh key `text:M:<order-length>` (if activeTextKey is null); `activeTextKey` is set to that key.

#### Scenario: text segment breaks on non-text event
<!-- test: use-tool-stream.test.ts:textSegmentBreaks -->
- **WHEN** a `text` event is followed by a `tool-input-start` event
- **THEN** the tool-input-start sets `activeTextKey: null`, so the next text event opens a fresh segment keyed by position (`text:M:<order-length>`), not reusing the previous segment.

#### Scenario: tool-input-delta accumulates partial JSON during composition
<!-- test: use-tool-stream.test.ts:toolInputDeltaAccumulates -->
- **WHEN** tool-input-start fires, creating a tool entry with `status: "pending"`, then tool-input-delta events arrive with JSON fragments
- **THEN** each delta appends to `state.toolCalls[toolCallId].partialInput`; this is cleared once tool-call-start lands (which carries the parsed `inputPreview`).

#### Scenario: tool-call-start transitions to running and captures input
<!-- test: use-tool-stream.test.ts:toolCallStartTransition -->
- **WHEN** tool-input-start → tool-input-delta* → tool-call-start arrives, with `inputPreview` and `riskLevel`
- **THEN** the tool call's `status: "pending"` becomes `"running"`, `inputPreview` is populated from the event (replacing any partial JSON), `riskLevel` is set, and `partialInput` is preserved (may be shown to the user if needed for debugging).

#### Scenario: tool-call-output appends to stdout or stderr
<!-- test: use-tool-stream.test.ts:toolCallOutputStreams -->
- **WHEN** tool-call-output events arrive with `channel: "stdout"` or `"stderr"` and `data: "<chunk>"`
- **THEN** the chunk is appended to `state.toolCalls[toolCallId][channel]`, building the output log incrementally.

#### Scenario: tool-call-end captures final status and output
<!-- test: use-tool-stream.test.ts:toolCallEndFinal -->
- **WHEN** tool-call-end arrives with `status: "completed" | "failed"`, `output`, `errorReason`, and `durationMs`
- **THEN** the tool call's `status`, `output`, `errorReason`, and `durationMs` are set; the call transitions from pending/running to terminal state.

#### Scenario: reasoning segments accumulate text and duration
<!-- test: use-tool-stream.test.ts:reasoningSegments -->
- **WHEN** reasoning-start → reasoning-delta* → reasoning-end arrive
- **THEN** the segment is created with `status: "thinking"` and `startedAt: Date.now()`, deltas append to `.text`, and reasoning-end sets `status: "done"` and `durationMs`.

#### Scenario: approval-required pauses stream consumption
<!-- test: use-tool-stream.test.ts:approvalPause -->
- **WHEN** approval-required event arrives
- **THEN** the approval is added to `state.pendingApprovals`, its key is added to order, `activeTextKey` is set to null (breaking text segments), and the consume loop pauses (see consume behavior); the loop resumes once approval-resolved fires or signalApprovalResolved is called.

#### Scenario: consent-required pauses stream consumption with external-MCP first-use prompt
<!-- test: use-tool-stream.test.ts:consentPause -->
- **WHEN** consent-required event arrives (OXA-816 first-use external MCP consent)
- **THEN** the consent is added to `state.pendingConsents` (keyed by approvalId), its key is added to order, `activeTextKey` is set to null, and the consume loop pauses (reusing the same approval waiter mechanism).

#### Scenario: plan-proposed and plan-resolved cycle
<!-- test: use-tool-stream.test.ts:planProposed -->
- **WHEN** plan-proposed arrives with `planId`, `title`, `steps`, and optional `rationale`
- **THEN** a plan entry is created with `status: "pending"`; when plan-resolved arrives with `decision: "approved" | "denied" | "amended"`, the status is updated.

#### Scenario: subagent-dispatched initiates fanout tracking
<!-- test: use-tool-stream.test.ts:subagentDispatched -->
- **WHEN** subagent-dispatched arrives with `fanoutId`, `parentMessageId`, and `children[]` array
- **THEN** an entry in `state.activeFanouts[fanoutId]` is created with `status: "running"` and the children mapped to running status; when subagent-completed arrives, the status and results are updated.

#### Scenario: memory-recalled and memory-written track memory operations
<!-- test: use-tool-stream.test.ts:memoryOps -->
- **WHEN** memory-recalled arrives with `queryId` and array of `MemoryRecallHit`
- **THEN** an entry is added to `state.memoryRecalls[queryId]`; when memory-written arrives with `memoryId`, `nodeRef`, and `weight`, an entry is added to `state.memoryWrites[memoryId]`.

#### Scenario: component directive registers lazy-loadable React component
<!-- test: use-tool-stream.test.ts:componentDirective -->
- **WHEN** component event arrives with `toolCallId`, `componentId` string, and `props: Record<string, unknown>`
- **THEN** an entry is added to `state.components[toolCallId]` with the componentId and props; the chat bubble later dispatches to CHAT_COMPONENTS[componentId] via React.lazy.

#### Scenario: usage event captures token and credit consumption
<!-- test: use-tool-stream.test.ts:usageEvent -->
- **WHEN** usage event arrives just before [DONE] sentinel
- **THEN** `state.turnUsage` is set with `{ promptTokens, completionTokens, totalTokens, creditsCharged? }` for display in the chat UI.

#### Scenario: reset clears all state idempotently
<!-- test: use-tool-stream.test.ts:reset -->
- **WHEN** the reset action is dispatched or a new turn begins
- **THEN** all state fields (messages, toolCalls, reasonings, plans, approvals, consents, pendingApprovals, components, etc.) are cleared; activeTextKey is set to null; order is emptied; all approval waiters are resolved so any in-flight consume loop unblocks.

---

### Requirement: Stream consumption pauses at approval and consent gates
<!-- id: use-tool-stream.consume -->
<!-- entities: StreamEvent, ApprovalWaiter, AbortSignal -->
<!-- depends_on: Stream event reducer accumulates SSE state -->
<!-- enforced: use-tool-stream.consume() -->

The consume function reads events from an SSE ReadableStream or AsyncIterable and dispatches them to the reducer. Before dispatching, if the event is approval-resolved or consent-resolved, the waiter for that ID is signalled immediately (so the loop can unblock). Then the event is dispatched. If the event is approval-required or consent-required, a new waiter Promise is created, registered by approvalId, and the loop awaits it (plus a macrotask boundary to allow React to flush the dispatch and render the card before continuing). The loop yields control and waits for the waiter to resolve before processing the next event. This ensures the approval/consent card is observable before the stream resumes.

#### Scenario: consume reads SSE ReadableStream and yields events
<!-- test: use-tool-stream.test.ts:consumeReadableStream -->
- **WHEN** consume is called with a ReadableStream and events are streamed line-by-line (format: `data: <json>\n`)
- **THEN** the stream is converted to an async iterable, parsed line by line (skipping non-data lines), and each JSON object is yielded after dispatch.

#### Scenario: consume pauses loop at approval-required until signalled
<!-- test: use-tool-stream.test.ts:consumePauseApproval -->
- **WHEN** an approval-required event is encountered
- **THEN** the event is dispatched to the reducer (so the approval card renders), a waiter Promise is created and registered, the loop yields control (including a macrotask boundary via setTimeout), and the loop awaits the waiter before processing the next event. The waiter resolves when signalApprovalResolved is called or an incoming approval-resolved event signals it.

#### Scenario: consume resumes on incoming approval-resolved within stream
<!-- test: use-tool-stream.test.ts:consumeIncomingResolve -->
- **WHEN** approval-required is followed (in the stream) by approval-resolved for the same approvalId
- **THEN** the approval-resolved event signals the waiter BEFORE dispatch, so the loop's await terminates; the dispatch then updates the UI to show the resolution; subsequent events continue processing without delay.

#### Scenario: consume resumes on signalApprovalResolved (user UI action)
<!-- test: use-tool-stream.test.ts:consumeUserResolve -->
- **WHEN** the user clicks Approve/Deny in the approval card, triggering signalApprovalResolved(approvalId) from chat-shell-client
- **THEN** the waiter is resolved, the consume loop unblocks, and subsequent events process immediately; the server action resolveApprovalAction is called in parallel, and when it completes, the stream continues.

#### Scenario: consent-required reuses approval waiter mechanism
<!-- test: use-tool-stream.test.ts:consentConsumeReuse -->
- **WHEN** consent-required event arrives
- **THEN** the same approval waiter mechanism is used (keyed by approvalId, with signalConsentResolved aliased to signalApprovalResolved); the loop pauses and resumes identically to approval-required.

#### Scenario: reset unblocks all pending waiters on unmount
<!-- test: use-tool-stream.test.ts:resetUnblocksWaiters -->
- **WHEN** reset is called while a consume loop is awaiting an approval waiter (e.g., on unmount)
- **THEN** all pending waiters are resolved, allowing the loop to exit cleanly; approvalWaiters.current is cleared.

#### Scenario: consume handles stream abort gracefully
<!-- test: use-tool-stream.test.ts:consumeAbort -->
- **WHEN** the AbortSignal is triggered while reading from the stream
- **THEN** the loop checks signal.aborted and breaks; the reader lock is released in a finally block; no error is thrown (AbortError is swallowed in chat-shell-client).

---

### Requirement: SSE stream is converted from ReadableStream to async iterable
<!-- id: use-tool-stream.readableToAsyncIterable -->
<!-- entities: ReadableStream, StreamEvent -->
<!-- enforced: use-tool-stream.readableToAsyncIterable() -->

The readableToAsyncIterable helper reads all chunks from a ReadableStream using getReader(), accumulates them in a TextDecoder, and yields decoded values. The reader lock is released in a finally block to allow garbage collection.

#### Scenario: stream chunks are decoded and yielded
- **WHEN** readableToAsyncIterable is called with a ReadableStream
- **THEN** chunks are read sequentially, decoded via TextDecoder, yielded one at a time, and the lock is released after iteration completes (or on error).

---

### Requirement: useToolStream hook exposes state and consume behavior
<!-- id: use-tool-stream.useToolStream -->
<!-- entities: ToolStreamState, UseToolStreamResult -->
<!-- enforced: use-tool-stream.useToolStream() -->

The useToolStream hook creates a reducer with the INITIAL_STATE, sets up an approval waiter map, and returns the entire ToolStreamState plus a set of control functions: consume (to process events), reset (to clear state), signalApprovalResolved (to unblock approval pauses), signalConsentResolved (aliased to approval signal), and computed flags hasBlockingApproval and hasBlockingConsent.

#### Scenario: hasBlockingApproval is true while any approval lacks resolution
- **WHEN** there are pending approvals in state.pendingApprovals with `resolution === undefined`
- **THEN** hasBlockingApproval is true (used to disable the composer).

#### Scenario: hasBlockingConsent is true while any consent lacks resolution
- **WHEN** there are pending consents in state.pendingConsents with `resolution === undefined`
- **THEN** hasBlockingConsent is true (also disables the composer until resolved).

---

### Requirement: Chat stream events parse and dispatch into reducer
<!-- id: chat-shell-client.sseToEvents -->
<!-- entities: StreamEvent, ReadableStreamDefaultReader, TextDecoder -->
<!-- enforced: chat-shell-client.sseToEvents() -->

The sseToEvents helper reads chunks from a ReadableStreamDefaultReader, accumulates them in a text buffer, splits on newlines, and parses lines starting with `data: ` as JSON. The special sentinel `data: [DONE]` ends the stream. Malformed JSON lines are skipped silently. AbortSignal is checked between reads so the iterator exits cleanly on interrupt.

#### Scenario: SSE lines are parsed as JSON
- **WHEN** sseToEvents receives a line like `data: {"type":"text","messageId":"m1","text":"hello"}`
- **THEN** the line is JSON-parsed and yielded as a StreamEvent object.

#### Scenario: [DONE] sentinel terminates iteration
- **WHEN** a line contains `data: [DONE]`
- **THEN** the generator returns (iteration ends cleanly without error).

#### Scenario: malformed JSON is skipped
- **WHEN** a data line contains invalid JSON
- **THEN** the parse fails silently (catch block), and the iterator continues to the next line.

#### Scenario: line buffering handles partial chunks
- **WHEN** a newline falls across two read chunks
- **THEN** the buffer carries the incomplete line to the next iteration, and when the full line is assembled, it is processed.

---

### Requirement: Chat shell client integrates stream consumption with composer and timeline rendering
<!-- id: chat-shell-client.ChatShellClient -->
<!-- entities: ChatMessage, StreamEvent, LiveToolCall, LiveApproval, LiveConsent, LivePlan, LiveFanout -->
<!-- depends_on: Stream event reducer accumulates SSE state, Stream consumption pauses at approval and consent gates, SSE stream is converted from ReadableStream to async iterable -->
<!-- enforced: chat-shell-client.ChatShellClient() -->

ChatShellClient wraps the useToolStream hook, manages the POST /api/v1/chat/stream fetch, and renders live timeline entries in true stream order. It intercepts page_form_fill tool events for cross-page form integration. The composer is disabled while hasPendingApproval is true (blocking approvals or consents). Approval/consent resolution via wrappedResolveApproval/wrappedResolveConsent immediately signals the consume loop, unblocking the stream before the server action completes. On stream completion, router.refresh() revalidates the RSC so persisted content replaces live state.

#### Scenario: submitted message triggers SSE fetch and live stream consumption
<!-- test: chat-shell-client.test.ts:submitTriggersFetch -->
- **WHEN** the user submits a message via the composer
- **THEN** wrappedSendAction calls sendAction (persisting the user message), obtains conversationId and userMessageId, then fetches `POST /api/v1/chat/stream` with the message, model, effort, and other form data; the response body is converted to an async event stream via sseToEvents, then piped through interceptFormFillEvents, then consumed via consume().

#### Scenario: live turn renders in correct stream order via order list
<!-- test: chat-shell-client.test.ts:liveTimelineOrder -->
- **WHEN** streaming events arrive (reasoning, tool, text, tool output, approval, consent, plan, fanout, memory, component)
- **THEN** each entity's first-appearance key is added to the order list (reasoning:id, tool:id, text:M:pos, approval:id, etc.); the renderEntry switch uses order to walk timeline entries in exact stream sequence, ensuring think→act→speak→observe interleaving is preserved, not grouped by type.

#### Scenario: tool-call-start auto-expands pending tool in timeline
<!-- test: chat-shell-client.test.ts:toolAutoExpand -->
- **WHEN** a tool call is rendered with `active: true` (status pending or running) and `isStreaming: true`
- **THEN** the ToolCallCard is passed `defaultOpen={true}`, so the user watches the tool arguments stream and output accumulate live.

#### Scenario: code-execute capability renders as CodeExecuteCard instead of generic tool
<!-- test: chat-shell-client.test.ts:codeExecuteCard -->
- **WHEN** a tool call with `capability === "agent.code.execute"` arrives
- **THEN** the renderEntry switch dispatches to CodeExecuteCard (with language extracted from inputPreview) instead of the generic ToolCallCard.

#### Scenario: approval card is rendered and blocks composer
<!-- test: chat-shell-client.test.ts:approvalBlocksComposer -->
- **WHEN** an approval-required event arrives
- **THEN** ApprovalCard is rendered in the timeline with the capability, inputPreview, riskLevel, and expiresAt; the composer is disabled (hasPendingApproval becomes true) until the approval is resolved (either user action or incoming approval-resolved).

#### Scenario: consent card is rendered for first-use external-MCP tool
<!-- test: chat-shell-client.test.ts:consentCard -->
- **WHEN** a consent-required event arrives (OXA-816)
- **THEN** ConsentCard is rendered with the capability, serverId, toolName, inputPreview, and expiresAt; the composer is disabled (hasBlockingConsent becomes true) until the consent is resolved; the card has a "Grant all tools" option to auto-grant future consent for that serverId.

#### Scenario: plan card is rendered with pending/resolved status
<!-- test: chat-shell-client.test.ts:planCard -->
- **WHEN** plan-proposed arrives with title and steps
- **THEN** PlanCard is rendered with `status: "pending"` and onResolve callback; when the user approves/denies/amends, resolvePlanAction is called; when plan-resolved arrives, the status updates.

#### Scenario: reasoning card is rendered with thinking status
<!-- test: chat-shell-client.test.ts:reasoningCard -->
- **WHEN** reasoning-start → delta* → reasoning-end arrives
- **THEN** ReasoningCard is rendered with text accumulating in real time (typewriter effect if isStreaming), and once reasoning-end arrives, the card shows "Thought for Xs" (collapsed disclosure, re-expandable).

#### Scenario: subagent fanout shows multiple child branches executing in parallel
<!-- test: chat-shell-client.test.ts:subagentFanout -->
- **WHEN** subagent-dispatched arrives with children array
- **THEN** SubagentFanout is rendered with the children, each showing capability and optional label; when the user clicks a child, onNavigateToChild is called (which sets window.location.hash to navigate to that message branch).

#### Scenario: memory recall and memory write cards display operation confirmations
<!-- test: chat-shell-client.test.ts:memoryCards -->
- **WHEN** memory-recalled or memory-written events arrive
- **THEN** MemoryCard is rendered showing the memory hit(s) or the written memory node reference and weight.

#### Scenario: component directive maps to lazy-loaded registry component
<!-- test: chat-shell-client.test.ts:componentRegistry -->
- **WHEN** component event arrives with `componentId: "svg-preview"` and props
- **THEN** renderEntry dispatches to CHAT_COMPONENTS["svg-preview"], which is a React.lazy import; the component is wrapped in Suspense with a ComponentSkeleton fallback; if componentId is not in CHAT_COMPONENTS, logUnknownComponent is called and UnknownComponentCard is rendered.

#### Scenario: unknown componentId shows fallback card and logs warning
- **WHEN** a component event arrives with an unregistered componentId
- **THEN** logUnknownComponent(componentId) logs a console.warn, and UnknownComponentCard renders an inline message: "This interactive component isn't available in this view. (<componentId>)".

#### Scenario: approval resolution signals consume loop and calls server action in parallel
<!-- test: chat-shell-client.test.ts:approvalResolution -->
- **WHEN** the user clicks Approve or Deny on an ApprovalCard
- **THEN** wrappedResolveApproval calls signalRef.current(approvalId) immediately (unblocking the paused consume loop), then returns the result of resolveApprovalAction (which persists the decision to the DB); the stream continues processing events without waiting for the server action to complete.

#### Scenario: consent resolution signals consume loop and calls server action in parallel
<!-- test: chat-shell-client.test.ts:consentResolution -->
- **WHEN** the user clicks Grant or Deny on a ConsentCard (with optional "Grant all tools" checkbox)
- **THEN** wrappedResolveConsent calls consentSignalRef.current(approvalId), then returns resolveConsentAction(approvalId, decision, grantAllTools); the stream continues without waiting for persistence.

#### Scenario: auto-scroll follows live content to bottom unless user scrolled up
<!-- test: chat-shell-client.test.ts:autoScroll -->
- **WHEN** the user submits (isStreaming becomes true) or order/textSegments change (new events)
- **THEN** if shouldAutoScrollRef.current is true (user is near the bottom or just submitted), scrollToBottom is called; the shouldAutoScrollRef is disabled if the user manually scrolls up >80px from the bottom, and re-enabled when they scroll back down.

#### Scenario: stream completion triggers router.refresh() to load persisted reply
<!-- test: chat-shell-client.test.ts:streamCompletionRefresh -->
- **WHEN** the consume loop finishes (all events processed, [DONE] received)
- **THEN** awaitingReconcileRef is set to true, and router.refresh() is called; when the RSC revalidates and the messages prop updates with the persisted assistant reply, the effect in the component clears live state (reset()), so the timeline transitions from live to persisted without flash.

#### Scenario: stream interrupt aborts fetch and clears live state
<!-- test: chat-shell-client.test.ts:streamInterrupt -->
- **WHEN** the user clicks the interrupt button while streaming
- **THEN** handleInterrupt aborts the fetch AbortController, calls reset() to clear live state, and sets isStreaming to false; the live timeline vanishes immediately.

#### Scenario: new turn created on first message resets conversation and navigates URL
<!-- test: chat-shell-client.test.ts:newConversationNav -->
- **WHEN** the user submits a message and wasNewConversation is true and result.conversationPublicId is returned
- **THEN** router.replace(`${pathname}?c=${conversationPublicId}`) updates the URL, and router.refresh() revalidates so the conversation nav list shows the new conversation immediately (without waiting for the stream to finish).

#### Scenario: page form fill events are intercepted before dispatch
<!-- test: chat-shell-client.test.ts:pageFormFill -->
- **WHEN** fillAwareStream (from interceptFormFillEvents) is consumed
- **THEN** page_form_fill tool-call-start events trigger onFormFillStartRef.current() (if set), and tool-call-end events with status "completed" and valid fields trigger onFormFillEndRef.current(result); all events are yielded unchanged after interception so the reducer still processes them.

#### Scenario: stream fetch failure is swallowed if persist succeeds
- **WHEN** the fetch to /api/v1/chat/stream fails (network error, timeout, etc.)
- **THEN** the error is caught and logged as a warning; isStreaming is set to false; the RSC revalidate still loads the persisted message (since sendAction succeeded and persisted the user message), so the UI recovers gracefully.

---

### Requirement: Activity timeline renders live events with motion and tonal status indicators
<!-- id: activity-timeline.TimelineItem -->
<!-- entities: LiveToolCall, LiveReasoning, LiveApproval, LivePlan, LiveFanout -->
<!-- enforced: activity-timeline.TimelineItem() -->

TimelineItem renders a left rail (dot + connector line) with a tonal status indicator (tone: thinking/running/done/failed/idle). The dot color reflects the tone. An optional pulsing ring animates when isActive is true and prefers-reduced-motion is not set. The connector line extends to the next item (hidden for the last item). Each item fades in on mount (via motion/react).

#### Scenario: tool call renders with running tone while status is pending or running
- **WHEN** a TimelineItem is rendered with `tone: "running"` and `isActive: true` and `isStreaming: true`
- **THEN** the dot is blue (bg-info), the pulsing ring animates (cyan ping), and the content fills (e.g., ToolCallCard with auto-expanded disclosure).

#### Scenario: tool call renders with done tone once status is completed
- **WHEN** tool-call-end arrives with status "completed"
- **THEN** the tone becomes "done", the dot becomes green (bg-success), the ring stops, and the card re-collapses (defaultOpen depends on the active flag at render time).

#### Scenario: tool call renders with failed tone on error
- **WHEN** tool-call-end arrives with status "failed"
- **THEN** the tone becomes "failed", the dot becomes red (bg-destructive), and the card shows the error reason.

#### Scenario: step markers are hidden in single-step turns
- **WHEN** a turn has only one step (stepCount === 1)
- **THEN** step timeline entries return null from renderEntry, so no step marker is rendered (the marker adds visual noise in single-step turns).

#### Scenario: multiple steps show step markers as subtle connectors
- **WHEN** a turn has stepCount > 1
- **THEN** each step-start event adds a StepMarker to the timeline with the step index; the markers bridge the semantic "think→act→observe→repeat" chain.

---

### Requirement: Chat component registry maps componentId strings to lazy-loaded React components
<!-- id: chat-component-registry.CHAT_COMPONENTS -->
<!-- entities: RenderDirective, ComponentContentBlock -->
<!-- enforced: chat-component-registry.CHAT_COMPONENTS -->

CHAT_COMPONENTS is a Record mapping stable componentId keys (e.g., "svg-preview", "capability-result", "graph-node-card") to lazy-loaded React components (React.lazy). All component props are spread from `block.props` (typed as `Record<string, unknown>`). If a componentId arrives that is not in CHAT_COMPONENTS, logUnknownComponent is called and UnknownComponentCard (a visible fallback) is rendered instead of silent skip.

#### Scenario: svg-preview renders an inline SVG or data-URL
- **WHEN** a component event arrives with `componentId: "svg-preview"` and `props: { svg: "<svg>...</svg>" }`
- **THEN** CHAT_COMPONENTS["svg-preview"] is lazily loaded and rendered with the props.

#### Scenario: mermaid-diagram renders a Mermaid diagram as client-side SVG
- **WHEN** componentId is "mermaid-diagram" and props contain diagram syntax
- **THEN** the Mermaid diagram is rendered client-side as an SVG artifact.

#### Scenario: capability-result is the generic fallback for undecorated outputs
- **WHEN** a capability tool result has no bespoke component and no embedded render directive
- **THEN** CHAT_COMPONENTS["capability-result"] is loaded; it renders the output as a deep-linked key/value card so raw JSON is never surfaced to the user.

#### Scenario: html-artifact renders model-generated HTML in a sandboxed iframe
- **WHEN** componentId is "html-artifact"
- **THEN** the component renders the HTML prop in a sandboxed iframe for security.

#### Scenario: connection-create-inline renders an inline connection wizard
- **WHEN** componentId is "connection-create-inline"
- **THEN** the component renders an inline GitHub (or fallback) connection flow.

---

### Requirement: Form fill events are transparently intercepted before dispatch
<!-- id: intercept-form-fill.interceptFormFillEvents -->
<!-- entities: StreamEvent, PageFormFillOutput, FormFillResult -->
<!-- enforced: intercept-form-fill.interceptFormFillEvents() -->

interceptFormFillEvents wraps an async generator of StreamEvents and yields every event unchanged, but intercepts page_form_fill tool events: on tool-call-start with capability "page_form_fill", the onStart callback is fired (optional); on tool-call-end for a tracked fill call (status "completed" and valid fields array in output), onEnd is called with a FormFillResult. Both callbacks are optional and never throw. The generator continues regardless.

#### Scenario: page_form_fill tool-call-start triggers onStart callback
- **WHEN** a tool-call-start event arrives with `capability === "page_form_fill"`
- **THEN** the toolCallId is registered in fillToolCallIds, onStart() is called, and the event is yielded unchanged.

#### Scenario: page_form_fill tool-call-end with valid output triggers onEnd
- **WHEN** tool-call-end arrives for a tracked fill toolCallId with `status: "completed"` and `output.fields` is an array
- **THEN** onEnd is called with a FormFillResult containing the fields; the toolCallId is removed from fillToolCallIds; the event is yielded unchanged.

#### Scenario: form fill callbacks are optional and never throw
- **WHEN** onStart is null or onEnd is null
- **THEN** the callback is not called, but interception continues; no error is thrown.

#### Scenario: unrelated tool events pass through unchanged
- **WHEN** tool-call-start or tool-call-end arrive for non-page_form_fill tools
- **THEN** the events are yielded unchanged without triggering interception.

---

### Requirement: Message bubble renders persisted content blocks in timeline or grouped layout
<!-- id: message-bubble.MessageBubble -->
<!-- entities: AssistantContentBlock, ChatMessage -->
<!-- enforced: message-bubble.MessageBubble() -->

MessageBubble renders a persisted message's contentBlocks array (if present) in one of two layouts: (1) a timeline layout (ActivityTimeline with TimelineItem per block) if the message has multiple blocks OR any block is non-text; (2) a plain grouped layout (div.space-y-2) if the message has a single text block. Each block is dispatched to a corresponding card component (TextContentBlock → MarkdownMessage, ReasoningContentBlock → ReasoningCard with status "done", etc.). If no contentBlocks exist, the message falls back to rendering plain `.content` as markdown.

#### Scenario: single text block renders plainly without timeline
- **WHEN** a message has `contentBlocks: [{ type: "text", text: "..." }]`
- **THEN** the block is rendered as MarkdownMessage without the ActivityTimeline rail.

#### Scenario: multiple blocks or non-text blocks render in timeline
- **WHEN** a message has `contentBlocks: [{ type: "reasoning", ... }, { type: "text", ... }, { type: "tool-call", ... }]`
- **THEN** each block is wrapped in TimelineItem and connected with the activity rail, preserving the original think→speak→act order.

#### Scenario: persisted reasoning block shows collapsed "Thought for Xs"
- **WHEN** a ReasoningContentBlock with `status: "done"` is rendered
- **THEN** the ReasoningCard shows a collapsed disclosure ("Thought for Xs"), re-expandable on click; no typewriter effect (unlike live reasoning which shows real-time text accumulation).

#### Scenario: component content block dispatches to registry
- **WHEN** a ComponentContentBlock with `componentId: "graph-node-card"` is rendered
- **THEN** CHAT_COMPONENTS["graph-node-card"] is lazily loaded and rendered with the props, wrapped in Suspense.

---

### Invariant: Stream order is never reordered after first appearance
<!-- entities: StreamEvent, ToolStreamState.order -->
<!-- enforced: use-tool-stream.reducer() -->

The order list in ToolStreamState is append-only (idempotent via withOrder). Once an entity key (reasoning:id, tool:id, text:M:pos, approval:id, etc.) is added, it is never removed or moved. This preserves exact stream-arrival order for the activity timeline and ensures the user observes true think→act→speak/observe sequencing, not grouped-by-type ordering.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Text segments break on non-text events
<!-- entities: LiveTextSegment, StreamEvent.type -->
<!-- enforced: use-tool-stream.reducer() -->

Whenever a non-text event arrives (reasoning-start, tool-input-start, approval-required, consent-required, plan-proposed, subagent-dispatched, memory-recalled, memory-written, component, step-start, usage), activeTextKey is set to null. The next text event opens a fresh segment keyed by position. This ensures that text appearing before a tool call and text appearing after are rendered as distinct timeline nodes, preserving the model's think→act→speak order even when text is interleaved with tool invocation.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Approval and consent gates block message composer
<!-- entities: ChatShellClient, MessageComposer -->
<!-- enforced: chat-shell-client.ChatShellClient() -->

The MessageComposer is disabled whenever `hasPendingApproval || hasBlockingConsent` is true. hasPendingApproval becomes true when any persisted approval-request block (from DB) has `resolution === undefined` OR any live approval or consent from the current stream is unresolved. The composer remains disabled until all approvals/consents are resolved (either user action on the card or incoming *-resolved event). This prevents the user from sending a new message while the agent is awaiting a decision.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Component registry renders fallback card for unknown componentId
<!-- entities: CHAT_COMPONENTS, UnknownComponentCard -->
<!-- enforced: chat-component-registry.logUnknownComponent(), chat-shell-client.renderEntry() -->

When a component event arrives with a componentId that is not in CHAT_COMPONENTS, logUnknownComponent is called (emitting a console.warn for observability), and UnknownComponentCard (a visible div with message and code) is rendered in its place. The user sees a clear signal instead of a silent empty gap. This is true for both live events (in renderEntry) and persisted blocks (in message-bubble.renderBlock).

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Form fill interception is transparent and non-blocking
<!-- entities: interceptFormFillEvents, StreamEvent -->
<!-- enforced: intercept-form-fill.interceptFormFillEvents() -->

interceptFormFillEvents passes every event through unchanged. Callbacks (onStart, onEnd) are optional and never throw. Interception of page_form_fill tool events is side-effect only; it does not alter the event or block the stream. The stream continues regardless of callback success or failure.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: SSE [DONE] sentinel ends stream cleanly
<!-- entities: StreamEvent -->
<!-- enforced: chat-shell-client.sseToEvents() -->

The special SSE line `data: [DONE]` terminates the stream generator (causes return, not error). Malformed JSON lines are skipped silently. AbortSignal checks allow the iterator to exit on user interrupt. The reader lock is always released (in finally block), ensuring proper resource cleanup and allowing the response body to be garbage collected.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Lazy component imports occur only on first render
<!-- entities: React.lazy, CHAT_COMPONENTS -->
<!-- enforced: chat-component-registry.CHAT_COMPONENTS -->

All CHAT_COMPONENTS entries are wrapped in React.lazy. Each component is only imported (bundled) the first time its componentId is encountered in a component event. Subsequent events reuse the already-loaded component, avoiding redundant imports.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Live state is cleared after RSC reconciliation
<!-- entities: ToolStreamState, ChatMessage -->
<!-- enforced: chat-shell-client.ChatShellClient() -->

After router.refresh() revalidates the RSC and the messages prop is updated with the persisted assistant reply, the effect in ChatShellClient calls reset() to clear live state (reasonings, toolCalls, plans, approvals, consents, order, etc.). This transitions the rendered timeline from live (with pulsing rings and typewriter text) to persisted (collapsed tool calls, terminal reasoning cards). The timeline survives the transition without duplication or flash because the persisted contentBlocks are rendered by message-bubble.tsx using the same card components.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: The exact shape and contract of the pageContext and fillableForm objects is not fully specified in the sampled files. The integration assumes a specific schema for form fill callbacks (onFormFillStart, onFormFillEnd) passed from a parent wrapper (AskDrawer/WandPanel). Full validation of this contract would require reading the ask/ and fill-types.ts modules. -->

