# MCP admission review

The review covers the uncommitted MCP HTTP boundary for #4202, its pinned xmcp 0.6.13 adapter, and the request work it starts in authentication, the capability kernel, served tools, and local-server routes.

| Severity | Location | Issue | Status |
| --- | --- | --- | --- |
| P1 | `apps/mcp/src/http-app.ts:91` | Releasing admission on socket close admitted new requests while earlier handlers continued allocating memory. | Fixed |
| P1 | `apps/mcp/src/http-app.ts:11` | The framework dispatch promise can settle before tool execution, or remain pending after an error response. Awaiting it alone cannot measure active work. | Fixed |
| P1 | `apps/mcp/src/http-app.ts:63` | The replacement HTTP edge omitted preflight methods and client metadata headers, preventing browser clients from making authenticated POST calls. | Fixed |
| P2 | `apps/mcp/src/http-app.ts:55` | The replacement HTTP edge omitted the configured OpenAI application challenge route. | Fixed |

## Request lifetime

A socket close does not cancel every downstream promise. The MCP SDK dispatches tool calls separately from its transport promise. The local-server and served-tool middleware also start promises that Express cannot observe through their return values.

`@oxagen/config/request-work` now retains admission until the connection has finished or closed and every registered operation has settled. Kernel invocation, MCP credential resolution, middleware, and the owned detached operations register their actual promises. A continuation attempting to start work after admission was released is refused before it starts.

The adapter wrapper tracks initialization and transport dispatch. A call to `response.end` also completes dispatch accounting because the pinned framework's error branch can send a response without resolving its promise. Actual tool promises keep the reservation while still running. Socket close events and protocol cancellation retain their original behavior.

## Verification

Added regression tests in `packages/config/src/request-work.test.ts`, `packages/oxagen/src/kernel.request-work.test.ts`, and `apps/mcp/src/http-app.test.ts`. They cover disconnects during initialization and execution, nested work, late continuations, adapter errors with unsettled promises, admission before body parsing, body limits, authentication order, local-server routing, CORS, and the verification challenge.

Inspected the installed framework source and its compiler injection. xmcp shares request context through a process-wide symbol and injects its tool import map into the bundled adapter. The existing relay diagnostics-channel mount remains imported by the unchanged bootstrap middleware.

`git diff --check` passed. No build, typecheck, lint, or test ran locally. CI remains required. This local review has no PR merge-readiness evidence. The coordinating agent owns the grouped commit, PR, CI, and deployment.

## Remaining work

The coordinating agent owns the shared admission reservations. It will raise control admission to eight requests with a 32 MiB reservation each. The original one MiB reservation did not account for four MiB JSON bodies and their object expansion.

A framework exception after headers are sent that neither ends the response nor settles dispatch retains its reservation. This fails closed on capacity. Source timeouts and operational recovery must handle stuck work without reopening its reservation while it is still running.

The custom edge serves the original pinned framework homepage at `/` before authentication. Its generator is bundled through an explicit alias to the installed framework source.

The fixes remain uncommitted for the coordinating agent's grouped PR. No PR link is available at this review point.
