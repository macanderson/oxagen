# @oxagen/agent

`@oxagen/agent` is the governed-agent runtime library. It turns capability contracts and registered MCP servers into tools a model may call, applies the per-call governance gates inside each tool, runs the in-app governance agent's turn on Stella's headless engine, and implements the `agent.*` capability handlers.

## Boundary

- **Owns:**
  - Tool materialisation (`src/runtime/materialize-tools.ts`): kill switches, IAM, plugin entitlement, tool RBAC, first-use consent, the approval pause, and the audit row, applied per call in each tool's `execute`.
  - The tool-count check against a provider's per-request cap (`src/runtime/tool-budget.ts`, #2611).
  - The governed turn (`runGovernedTurn` in `src/runtime/governed-turn.ts`): one bounded, metered model turn over the materialised tools, run on the `stella-serve` engine (ADR-053).
  - The assistant turn and its SSE stream (`src/runtime/assistant-turn.ts`, `src/runtime/assistant-stream.ts`) and approval resume (`src/runtime/approval-resume.ts`).
  - The assistant turn's steering (`src/runtime/assistant-steering.ts`): published context records and the workspace's instructions, assembled by `@oxagen/steering-assembler` into the system prompt, with the manifest recorded on the run as a `steering.manifest` frame (ADR-093 §7, #4158).
  - The published context-record read and the record adapter (`src/runtime/published-steering.ts`). The in-app turn and a wrapped agent's policy bundle (`packages/handlers/src/lib/tacho-steering.ts`) both read steering through it, so a record reads the same in both.
  - The plugin-type contributor registry and the MCP server contributors (`src/runtime/plugin-type.ts`, `src/runtime/plugin-types/`).
  - The MCP client and the Neo4j projection of invoked tools (`src/dispatch/`), and agent memory in Neo4j (`src/memory/`).
  - The `agent.*` handlers (`src/handlers/`): approvals, the MCP registry and consent ledger, memory, agent definitions and roles, executions, traces, and error clustering. `src/register.ts` registers them.
- **Does not own:**
  - The kernel, `invoke()`, contracts, and the gate slots: [`@oxagen/oxagen`](../oxagen/README.md). A materialised contract tool calls `invoke()`, and the kernel enforces the gates again there.
  - The IAM, billing, entitlement, and rules gate implementations: [`@oxagen/iam`](../iam/README.md), [`@oxagen/billing`](../billing/README.md), [`@oxagen/plugins`](../plugins/README.md), and [`@oxagen/rules`](../rules/README.md).
  - Model calls and metering: [`@oxagen/ai`](../ai/README.md).
  - The agent loop itself: `stella-serve`, reached through `@oxagen/stella-engine-client`. Oxagen governs agents and does not run them (ADR-043).
  - The foundation handlers: [`@oxagen/handlers`](../handlers/README.md).
  - The chat HTTP route: `apps/api/src/routes/v1/chat.stream.ts`.
- **Depends on:**
  - `@oxagen/oxagen`: `invoke`, the registry, `registerHandler`, and contract types.
  - `@oxagen/ai`: `streamAgentReply`, model selection, and funding-source resolution.
  - `@oxagen/stella-engine-client`: the `stella-serve` engine protocol.
  - `@oxagen/iam`: `assertOrgRole`, agent-run authorization, the kill-switch guard, and the IAM bootstrap used on approval resume.
  - `@oxagen/billing`: the pre-turn credit gate and the billing bootstrap used on approval resume.
  - `@oxagen/plugins`: installed-plugin entitlement and MCP credentials.
  - `@oxagen/rules`: the decision-rules bootstrap used on approval resume.
  - `@oxagen/database` and `@oxagen/tenancy`: scoped Postgres access for approvals, consent, and the MCP registry.
  - `@oxagen/ontology`: scoped Neo4j sessions for memory and tool projection.
  - `@oxagen/run-ledger` and `@oxagen/run-evidence`: run records and evidence digests for a turn.
  - `@oxagen/steering-assembler`: ranking and budgeting the turn's steering, and its manifest.
  - `@oxagen/telemetry`: tool-call telemetry and error capture.
  - `@oxagen/mcp-config`: settings, credentials, and permissions for file-configured MCP servers (`src/runtime/plugin-types/file-mcp.ts`).
  - `@oxagen/crypto`: encryption of stored MCP server auth and approval-resume payloads.
  - `@oxagen/config`: env readers and the outbound URL guard for MCP server URLs.
- **Used by:** `apps/api`, `apps/app`, `apps/mcp`, `apps/app_deprecated`, `@oxagen/handlers`, `@oxagen/inngest-functions`, and `tools/scripts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `registerHandlersOnce("@oxagen/agent", ...)` over `agentHandlerNames` | injection | `packages/agent/src/register.ts` | Side-effect import in `apps/api/src/bootstrap.ts`, `apps/mcp/src/middleware.ts`, and `apps/app/src/server/kernel.ts` |
| `materializeTools(ctx, opts)` | export | `packages/agent/src/runtime/materialize-tools.ts` | `src/runtime/assistant-turn.ts`, `src/runtime/approval-resume.ts`, `src/runtime/plugin-types/file-mcp.ts`, and `src/handlers/tools.load.ts`. `runGovernedTurn` takes the result as input |
| `runGovernedTurn(input)` | export | `packages/agent/src/runtime/governed-turn.ts` | `packages/inngest-functions/src/lib/run-enrichment.ts` and `src/runtime/assistant-turn.ts` |
| `readPublishedSteeringCandidates`, `recordCandidate`, `readSteeringRows` | export | `packages/agent/src/runtime/published-steering.ts` | `src/runtime/assistant-steering.ts` and `packages/handlers/src/lib/tacho-steering.ts` |
| `streamAssistantTurn` | export | `packages/agent/src/runtime/assistant-stream.ts` | `apps/api/src/routes/v1/chat.stream.ts` |
| `registerPluginType` / `getPluginTypeContributors` | registry | `packages/agent/src/runtime/plugin-type.ts` | `src/runtime/plugin-types/mcp.ts`, `file-mcp.ts`, and `placeholders.ts` register on import |
| `assertToolListFitsProvider` | boundary | `packages/agent/src/runtime/tool-budget.ts` | `runGovernedTurn` and `src/runtime/tool-belt.ts` refuse a turn whose tool count exceeds `PROVIDER_TOOL_LIMITS` |
| Gate bootstrap on approval resume | injection | `packages/agent/src/runtime/approval-resume.ts` | Calls `bootstrapIAMRuntime`, `bootstrapBillingRuntime`, `bootstrapEntitlementRuntime`, and `bootstrapDecisionRulesRuntime` before it re-materialises the approved tool |
| Registry loader | boundary | `packages/agent/src/registry-loader.ts` | Loads `@oxagen/oxagen`'s registry by dynamic import to break the static package cycle |

## Entry points

- `.` (`src/index.ts`): `materializeTools`, `runGovernedTurn`, `streamAssistantTurn`, approvals, stream events, the MCP client, tool projection, Neo4j memory, `resolveHandler`, and `buildChatSystemPrompt`.
- `./register` (`src/register.ts`): the side-effect module that registers every `agent.*` handler.
- `./handlers` and `./handlers/*` (`src/handlers/`): the handler index and individual handler modules.
- `./runtime/*`, `./dispatch/*`, `./memory/*`: individual runtime, dispatch, and memory modules.

## Rules

- The tool-list filter in `materializeTools` is presentation only. The kernel's `invoke()` gate is the enforcement, and every contract tool reaches it.
- A tool that requires approval stays on the list and routes to the approval flow when called. When a turn carries an agent-run context, a tool the delegation ceiling denies is never materialised.
- There is no in-process fallback when `stella-serve` is unreachable. The turn fails with `EngineUnavailableError` before anything streams (ADR-053 §4).
- Every completion a turn needs goes through `streamAgentReply` in `@oxagen/ai`. The engine sees tool results and never sees a credential.
- A multi-step tool loop passes a `stopWhen` predicate. The AI SDK default stops after the first step.
- `PROVIDER_TOOL_LIMITS` keys on model-id prefix. A provider missing from it means no cap this codebase has confirmed, not no cap.
- The registered capability name often differs from the handler file name (ADR-025). Read the contract's `name`.

## Tests

```bash
pnpm --filter @oxagen/agent test:unit src/runtime/materialize-tools.test.ts
```

Never put `--` before the filename. Tests live beside the source under `src/`.
