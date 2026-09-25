# ADR-187: Oxagen's gateway carries every customer agent's model and MCP traffic, and Oxagen holds the keys

- **Status:** Proposed
- **Date:** 2026-09-25
- **Owners:** platform, gateway
- **Decided by:** the maintainer set the direction on 2026-09-25. This record awaits acceptance
- **Related:** ADR-094 (the gateway on the laptop), ADR-143 (credential custody on the laptop), ADR-122 (external tools need a person), ADR-078 (wrapped and connected; one tool builder), ADR-095 (the tier ladder), ADR-096 and ADR-152 (the contained tier), ADR-165 (the governed action is billed), #3299 (Phase 4), #4295, #4310
- **Plan:** `docs/gateway-plan.md` in `macanderson/oxagen-roadmap`

## Context

Checked at `main` `7dfcd0b95`.

Oxagen is where a team sets up its agents: the tools they may call, the rules and budgets they run under, the context records that steer them, their skills, their profiles, and their memories. On `main`, most of that stops at the authoring side:

- The workspace registers MCP servers in `mcp.mcp_servers`, with encrypted credentials (`packages/database/src/schema/mcp.ts:131-204`). Only the in-app agent's turn uses them (`packages/agent/src/runtime/materialize-tools.ts:991-1009`). No path serves them to Claude Code, Codex, Cursor, the Stella CLI, or Claude Desktop.
- The MCP gateway in `tachod` serves Oxagen's own read-only capabilities to Claude Desktop alone (`packages/iam/src/machine-key-scope.ts:144-151`, `packages/tacho/src/wire.ts:343`).
- Skills (`.oxagen/skills/`), agent-definition instructions, and memories reach no wrapped harness. Context records reach them at session start only.
- The model gateway runs on each laptop (ADR-094), and the vendor key sits in `credentials.json` on that laptop (ADR-143). The machine's owner can unset the base URL or decrypt the file and call the vendor directly, so a paused or killed run can keep going.

ADR-094 put the gateway on the laptop and rejected a cloud proxy, so prompt bodies and keys would never reach Oxagen. The code has since moved half of that: the proxy now records each request and response as the body of its `llm_call` frame and ships it to Oxagen (`packages/tacho/src/collector/model-proxy.ts:10-15`), and a workspace with no retention policy defaults to `content_exact` (`packages/handlers/src/lib/tacho-host.ts:262-264`). Prompt bodies already reach Oxagen by default, as a copy after the call. The key still stays on the laptop. They also leave Oxagen unable to stop an agent the owner does not want stopped, and unable to deliver the toolbelt at all.

Kong solves the same shape for APIs and MCP. Its control plane is a service. Its data plane, the gateway that carries traffic, runs either on Kong's infrastructure (Dedicated Cloud Gateways) or in the customer's network (hybrid mode), where it pulls configuration from the control plane and keeps proxying from a cached copy while the control plane is down. Its AI MCP Proxy applies OAuth, per-tool access lists, and rate limits, and logs each call.

## Decision

**Every customer agent's model and MCP traffic goes through Oxagen's gateway. Oxagen holds the model keys and the MCP credentials. Oxagen hosts the gateway by default, and a customer may run the same gateway in its own network.**

1. **Two planes.** The control plane is the Oxagen API and app. It holds each agent's mandate, the key vault, and the record, and it computes the tier. It carries no model or MCP call. The data plane is the gateway, one service with a model listener (Anthropic Messages, OpenAI Responses and Chat Completions) and an MCP listener (streamable HTTP). The routing, metering, budget, allowlist, and interrupt logic in `packages/tacho/src/collector/model-proxy.ts` moves into it.
2. **Two deployments, one image.** Oxagen hosts the gateway by default. A customer may host it: the gateway dials the control plane outbound over mutual TLS, pulls a signed configuration, and keeps serving from its cache while the control plane is unreachable. On a customer-hosted gateway, keys and credentials stay in the customer's KMS, and prompt and tool bodies stay in the customer's network. Only digests, usage, and frames reach Oxagen.
3. **Oxagen holds the keys.** A team adds its vendor organization keys to Oxagen, encrypted under one KMS key per organization. Enrollment removes vendor keys from the harness. The harness holds an `oxrt_` run token that the gateway mints for one agent, one host, and one run.
4. **A token is short-lived, and a run is not.** `tachod` refreshes the token for as long as the run may continue, which can be days. Claude Code re-runs its key helper every five minutes and on any 401. Codex, which reads a fixed value, gets a run-scoped token.
5. **The kill switch is checked on every call.** Pause, cancel, and kill mark the run at the gateway. The gateway aborts the run's calls in flight and refuses its next call, whatever the token's expiry, and stops minting for it. The harness has no other key to try.
6. **The gateway serves the toolbelt.** Each registered server gets its own endpoint, `/mcp/<agent>/<server>`, written into the harness under the server's registered name, so tool names stay `mcp__<server>__<tool>`. The gateway builds each agent's list with the server's `materializeTools`: one tool builder, as ADR-078 §4 requires. It connects upstream with the stored credential, runs OAuth itself, applies per-tool rules and approval, and meters and bills each call (ADR-165).
7. **Enrollment imports and pins.** Enrollment moves each harness's MCP servers into the workspace toolbelt, with their credentials, and replaces them with gateway entries. It edits the user's config directly and restores it byte for byte on `unenroll`. It changes the repository's config (`.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`, `.stella/mcp.toml`) through a pull request, the way a context record lands, which also reaches cloud sessions that clone the repository. On a managed device it pins the harness to the gateway: `managed-mcp.json` for Claude Code, `requirements.toml` for Codex, and the admin allowlist Cursor keeps in its own dashboard.
8. **An agent can hold an external-tool grant.** An agent's own identity may be granted an external tool, so the toolbelt works without a person on the call. This replaces ADR-122:19.
9. **Agents reach one another through the gateway.** Every agent connects to the gateway whatever its runtime, so the gateway serves `send_agent_message`, `list_agent_messages`, and `start_agent_run` to all of them. A message follows `mission-control-spec.md` §7.6 in `macanderson/oxagen-roadmap`: it enters the recipient's next model request as quoted evidence with the sender named, or its next hook boundary where model calls skip the gateway. A trigger creates a work order, linked to the parent run, and goes to the target agent's own runtime, since an agent has one: `tachod` on its enrolled host, the contained launcher on its CI runner, or its customer-hosted runner. The child runs under its own mandate, and starting another agent needs a grant naming the sender and the target. Oxagen routes the start and runs no turn, so ADR-043 stands.
10. **`tachod` keeps the local work.** It runs the hooks, which veto the harness's built-in tools and deliver steering at session start. It fetches run tokens and relays a stdio MCP server that must run on the laptop. Skills and per-harness agent files reach the repository through a pull request, as context records and agent definitions already do.

**What this does not reach, stated plainly:**

- Tools the vendor runs: claude.ai connectors, Codex apps and hosted web search, Cursor Cloud Agents, Claude Desktop's remote connectors, and built-in web search and fetch. A managed device turns them off. Elsewhere the record marks them as unrouted.
- Subscription logins. Oxagen cannot hold a Claude Pro or Max login or a ChatGPT sign-in, so a run on one stays `harness_held`, and the kill switch does not bind it.
- A personal key the machine's owner brings. The vendor's organization settings and the `contained` tier close that gap. The gateway does not.

## Consequences

- The gateway tier gains a second source of evidence: a call the gateway carried is on the control plane's own record. The run also records who held its key (Oxagen, the customer's KMS, or the harness). A surface may say "enforced" for the kill switch only when Oxagen or the customer's KMS held the key, scoped to "for calls made with the organization's keys".
- An Oxagen-hosted gateway carries prompt and tool bodies during the call, even for a workspace on `digest_only`. The workspace's retention policy still decides what is kept. Today's default, `content_exact`, needs a decision before the model gateway ships (below).
- Custody moves off the laptop. `credentials.json`, the local HMAC signing key, and the local model proxy go away for brokered harnesses. The local relay stays only for stdio servers that need the machine.
- One platform variable, `AUTH_TOKEN_ENCRYPTION_KEY`, encrypts every workspace's MCP credentials today (`packages/plugins/src/credentials/kms.ts:4-5`). That becomes one KMS key per organization.
- The in-app agent is not a customer agent and is outside this record. #4310 removes the workspace toolbelt and rules from it.
- Stella reads MCP servers only from each workspace's `.stella/mcp.toml` and from plugins. The gateway entries reach that file through a pull request. Stella skips it in an untrusted checkout, and it has no managed server list an admin could pin.

## ADR-094 objections

ADR-094 rejected "a cloud-hosted proxy" for four reasons. This record answers each:

- **"It adds a hop."** It does. The gateway runs in regions near the vendors' endpoints, and a customer-hosted gateway runs in the customer's own network. The hop is the price of a kill switch the owner cannot remove.
- **"An availability dependency."** The gateway serves from its cached configuration and keeps minting run tokens while the control plane is down, as Kong's data plane does. A gateway outage stops routed calls. That is the same failure a daemon outage causes today, where a harness pointed at a dead loopback gets a refused connection.
- **"Every prompt body and every customer's source code through Oxagen's network."** That already happens by default: the laptop proxy ships each request and response to Oxagen as a frame body unless the workspace chooses `digest_only`. The gateway changes when the body crosses, during the call instead of after it, and the retention policy still decides what Oxagen keeps. A customer that cannot accept that runs the gateway itself, and the bodies stay in its network.
- **"It moves the vendor credential off the machine."** That is the point. A credential on the machine is a credential the owner can use to route around Oxagen.

## Supersedes and amends

- **Supersedes ADR-094 in part.** The gateway is a service Oxagen or the customer hosts, not a daemon on the laptop, and an Oxagen-hosted gateway carries prompt bodies under the retention policy. ADR-094's routing, metering, and budget logic stays and moves.
- **Supersedes ADR-143 in part.** Vendor keys move from the laptop to Oxagen's vault or the customer's KMS. The run token, its short life, and the swap at the gateway stay.
- **Supersedes ADR-122:19.** An agent's own identity may hold an external-tool grant.
- **Keeps ADR-078 §4.** There is one tool builder, and it runs on the server.

## Alternatives considered

**Keep the gateway on the laptop (ADR-094).** Rejected. The machine's owner can route around it and read the key, so Oxagen cannot stop an agent, and the laptop cannot build the toolbelt without a second tool builder.

**A relay per MCP server on the laptop, with the harness's own servers left in place.** Rejected. It routes the harness's existing servers and never delivers the workspace toolbelt, and the credentials stay on the machine.

**Customer-hosted only.** Rejected as the default. A team without a network to run the gateway in could not start. The customer-hosted gateway stays for the customers who need custody.

## Open for acceptance

1. The retention default for prompt and tool bodies an Oxagen-hosted gateway carries.
2. How a Codex run-scoped token is revoked when the harness restarts mid-run.
3. The regions Oxagen hosts the gateway in first.
