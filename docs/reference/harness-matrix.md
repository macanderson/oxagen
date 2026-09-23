# Harness and repository coverage

Checked against `main` at `7245b8825` on 2026-09-22. This is a source audit, not a live harness certification. The recovered draft included a scratch enrollment transcript from a fake control plane; it is not evidence that a real harness ran its hooks. No new enrollment test was run for this audit.

The [model gateway audit](../audits/2026-09-21-model-gateway-arming.md) explains the routing and bypass mechanisms. Its original Stella row predates the Anthropic base-URL writer. This page uses the current writer and separates code that installs hooks from evidence that a particular installation executes them.

## Wrapped harnesses

Each source abbreviation below links to the implementation. “Metered” and “budget” cover calls that pass through the model proxy. An operator can still change a local setting or call a provider directly. No row claims OS containment.

| Harness | Recorded | Metered | Can deny | Can ask | Enforced budget | Contained |
|---|---|---|---|---|---|---|
| Claude Code | 33 configured events: 5 command hooks and 28 HTTP events [C] | Routed Anthropic calls [M] | PreToolUse denial [H] | Native permission prompt via `ask` [H] | Routed session ceiling when the mandate enables it [B] | No contained tier [T] |
| Codex | 12 command events [X]; hooks must be trusted [O] | Routed OpenAI calls [M] | PreToolUse denial [H], [O] | Unsupported: the current client forwards `ask`, which Codex ignores after reporting a hook error [H], [O] | Routed session ceiling [B] | No contained tier [T] |
| Cursor | 10 configured events [U] | No configured model route [M] | Tool, prompt, and subagent refusals [U] | Converted to deny with an explanation [U] | None through the current model proxy [M] | No contained tier [T] |
| Stella | 8 command events; no SessionEnd [S] | Anthropic provider route only [M] | Native deny [A] | Native `require_approval` [A] | Routed Anthropic session ceiling only with exactly one live Stella session [B], [M] | No contained tier [T] |
| Gemini CLI, not verified by enrollment | No Oxagen adapter [W]; vendor has hooks [G] | No Oxagen route [M]; API-key base-URL extension exists [GC] | Not implemented; vendor BeforeTool can refuse [G] | No native ask in the documented decision schema [G] | Not implemented; BeforeModel can refuse a call [G] | No Oxagen contained tier [T] |
| Aider, not verified by enrollment | No Oxagen adapter [W]; history files offer an extension point [AI] | No Oxagen route [M]; OpenAI base-URL option exists [AI] | No pre-action hook documented in its options [AI] | No documented pre-action approval adapter [AI] | Not implemented; a future proxy route could gate model calls [AI], [B] | No Oxagen contained tier [T] |

[C]: ../../packages/tacho/src/host/settings-writer.ts
[X]: ../../packages/tacho/src/host/codex-writer.ts
[H]: ../../packages/tacho/src/claude-code/hook-client.ts
[U]: ../../packages/tacho/src/claude-code/cursor-adapter.ts
[S]: ../../packages/tacho/src/host/stella-writer.ts
[A]: ../../packages/tacho/src/claude-code/stella-adapter.ts
[M]: ../../packages/tacho/src/host/model-base-url.ts
[B]: ../../packages/tacho/src/collector/model-proxy.ts
[T]: ../../packages/tacho/src/envelope.ts
[W]: ../../packages/tacho/src/wire.ts
[O]: https://learn.chatgpt.com/docs/hooks
[G]: https://geminicli.com/docs/hooks/reference/
[GC]: https://geminicli.com/docs/reference/configuration/
[AI]: https://aider.chat/docs/config/options.html

Claude Desktop is a connected gateway harness, not one of the four wrapped harnesses in [wire.ts][W]. Custom-agent integrations speak the hook protocol themselves; see [the wrapped-agent examples](https://github.com/macanderson/oxagen-wrapped-agents). Neither path inherits the lifecycle coverage of a native adapter.

### Codex trust and approval

The current enrollment writer installs hooks but does not persist their trust. Codex skips new or changed non-managed hooks until their definitions are reviewed and trusted. Operators can inspect them with `/hooks`. This is why a populated hooks file does not prove recording. The dirty Codex trust worktree contains a recovery draft, but it is not shipped in the audited revision. Codex also does not honor PreToolUse `ask`; the hook client needs a refusal translation before an ask rule can safely govern it. These findings come from [the official hooks documentation][O] and the linked client source, without a live Codex exercise.

### Cursor and Stella

Cursor's adapter refuses an ask because its pre-tool protocol cannot provide the requested approval behavior. Enrollment writes no Cursor model route, so its recorded tool activity does not establish metered spend or a budget ceiling. Stella's writer routes its Anthropic provider; another provider can bypass that route. Stella supplies no session identifier. The proxy attributes a request only when exactly one Stella session is live on the host. With two or more, it records the call as unattributed and skips the session ceiling in the audited revision. Operators cannot rely on a per-session ceiling for concurrent Stella processes. Stella has no SessionEnd hook, so the collector uses process lifecycle evidence to close its sessions. See the adapters above and [the collector](../../packages/tacho/src/collector/daemon.ts).

### Gemini CLI extension

A new adapter would map vendor hook names and decisions, then add enrollment, registry, and desktop support. BeforeTool can deny a tool; BeforeModel can deny a model request. The documented decision values do not include ask. `GOOGLE_GEMINI_BASE_URL` applies to API-key authentication, while Vertex has a separate override. Do not infer an OAuth route from either setting. Estimate: 5 to 7 engineer-days for an initial adapter and one tested proxy route, including schema changes and regression coverage. This is an estimate, not verified support. [Hooks][G], [configuration][GC].

### Aider extension

Aider exposes conversation-history files and an OpenAI API-base option. Its documented lint and test commands operate after edits, so they cannot enforce a pre-edit refusal. A history tailer plus a routed model endpoint could add partial recording and metering. Estimate: 4 to 6 engineer-days, with tool denial and ask still unsupported. Containment would require a separate OS boundary. No adapter or live enrollment was verified. [Options][AI].

## GitLab gap

GitHub is the only implemented repository host. The provider columns in [the binding schema](../../packages/database/src/schema/ingestion.ts) leave room for another host, but contracts, token resolution, and handlers still select GitHub. Ingestion connectors do not provide a governed merge-request workflow.

This inventory uses registered capability names. Their source files retain dotted names in [the contract directory](../../packages/oxagen/src/contracts/). “Adapt” means the capability can keep its purpose and most fields, with a provider implementation. It does not promise a drop-in handler.

| Current capability or seam | GitLab equivalent | Contract work |
|---|---|---|
| `get_pr`, `get_pr_diff` | Merge request, diffs, notes | Adapt repository identity and provider-specific status fields |
| `get_ci_status`, `list_branches` | Commit statuses, pipelines, branches | Adapt check conclusions and project identity |
| `open_context_pr`, `get_context_pr`, `merge_context_pr` | Open, read, merge a merge request | Reuse governance intent; translate checks and enforce the reviewed head |
| `propose_record`, `revise_context_record`, `publish_context_record`, `set_governance_mode`, `get_steering_freshness` | Branch/file changes and merge history | Route through a provider-neutral version of the steering port |
| `list_proposals`, `dismiss_proposal`, `list_context_records`, `promote_context_record` | Local proposal and record state | Keep local semantics; audit any provider-specific downstream side effects |
| `commit_agent_definition`, `propose_agent`, `propose_skill`, `update_skill_config`, `propose_configuration_clone` | Repository commits and merge requests | Move direct GitHub calls behind provider dispatch |
| `create_workspace` | Create a workspace with a GitLab main project | Replace the `mainRepo.provider` GitHub literal, GitHub App installation lookup, and GitHub source-connection write; a workspace requires a main repository |
| `bind_main_repository`, `link_repository`, `list_repositories`, `unlink_repository`, `set_production_branch` | Projects, branches, binding lifecycle | Add provider support and nested project paths; preserve tenant scope |
| `get_main_repository`, `get_repository_tree`, `open_init_pr` | Project metadata, repository tree, merge requests | Replace GitHub-specific output fields and refusals deliberately |
| `attach_github_installation`, `list_github_installations`, `list_installation_repositories` | Token or OAuth connection and project discovery | Separate connect flow; a GitLab token is not an App installation |
| `configure_repo`, `sync_repo`, `pause_repo`, `resume_repo`, `get_repo_metrics` | Connector configuration, sync, local metrics | Audit connector dispatch; these operations do not by themselves implement PR governance |
| [App authentication](../../packages/github/src/app-auth.ts), [workspace tokens](../../packages/github/src/workspace-token.ts) | Project token or OAuth token | New encrypted credential resolver and revocation path |
| [Webhook ingress](../../apps/api/src/routes/v1/github-webhook.ts), [GitHub ingestion](../../packages/ingestion/src/connectors/github/) | Project/group webhook events | New authentication and event translation; no reuse of GitHub HMAC assumptions |

The implementation starting point is [the steering repository port](../../packages/handlers/src/context.steering.github.ts). Its GitHub provider filters, check-run model, and credential lookup need explicit dispatch. GitLab provides [merge requests](https://docs.gitlab.com/api/merge_requests/), [project access tokens](https://docs.gitlab.com/api/project_access_tokens/), [commit statuses](https://docs.gitlab.com/api/commits/), and [webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/); their identifiers and authentication differ from GitHub's.

The complete GitLab handoff is [#3762](https://github.com/macanderson/oxagen/issues/3762), under the innovation pillar. It requires a real project exercise from workspace creation and binding through an approved merge and steering publication, alongside tenant, credential, and duplicate-webhook regression coverage. Estimate: 3 to 4 engineer-weeks for gitlab.com. Self-managed hosts need an explicit server and network policy before support is claimed.
