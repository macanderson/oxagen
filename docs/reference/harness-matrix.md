# Harness and repository coverage

Checked against `main` at `7245b8825` on 2026-09-22. This is a source audit, not a live harness certification. The recovered draft included a scratch enrollment transcript from a fake control plane; it is not evidence that a real harness ran its hooks. No new enrollment test was run for this audit.

The [model gateway audit](../audits/2026-09-21-model-gateway-arming.md) explains the routing and bypass mechanisms. Its original Stella row predates the Anthropic base-URL writer. This page uses the current writer and separates code that installs hooks from evidence that a particular installation executes them.

## Wrapped harnesses

Each source abbreviation below links to the implementation. “Metered” and “budget” cover calls that pass through the model proxy. An operator can still change a local setting or call a provider directly. No row claims OS containment.

| Harness | Recorded | Metered | Can deny | Can ask | Enforced budget | Model list | Contained |
|---|---|---|---|---|---|---|---|
| Claude Code | 33 configured events: 5 command hooks and 28 HTTP events [C] | Routed Anthropic calls [M] | PreToolUse denial [H] | Native permission prompt via `ask` [H] | Routed session ceiling, and the agent's UTC-day ceiling on a host that advertises `daily_budget`, when the mandate enables them [B], [D] | Routed calls refused with `model_not_permitted` when the workspace arms its lists [L] | No contained tier [T] |
| Codex | 12 command events [X]; hooks must be trusted [O] | Routed OpenAI calls [M] | PreToolUse denial [H], [O] | Unsupported: the current client forwards `ask`, which Codex ignores after reporting a hook error [H], [O] | Routed session ceiling and UTC-day ceiling [B], [D] | Routed calls, as for Claude Code [L] | No contained tier [T] |
| Cursor | 10 configured events [U] | No configured model route [M] | Tool, prompt, and subagent refusals [U] | Converted to deny with an explanation [U] | None. Cursor's model calls do not reach the proxy, so neither the session nor the day ceiling holds [M] | None. Out of scope: Cursor documents no base URL the proxy could take, so no list is checked [M] | No contained tier [T] |
| Stella | 8 command events; no SessionEnd [S] | Anthropic provider route only [M] | Native deny [A] | Native `require_approval` [A] | Routed Anthropic session ceiling only with exactly one live Stella session [B], [M]. The day ceiling covers every routed Anthropic call, attributed or not [D] | Anthropic route only [L], [M] | No contained tier [T] |
| Gemini CLI, not verified by enrollment | No Oxagen adapter [W]; vendor has hooks [G] | No Oxagen route [M]; API-key base-URL extension exists [GC] | Not implemented; vendor BeforeTool can refuse [G] | No native ask in the documented decision schema [G] | Not implemented; BeforeModel can refuse a call [G] | Not implemented [M] | No Oxagen contained tier [T] |
| Aider, not verified by enrollment | No Oxagen adapter [W]; history files offer an extension point [AI] | No Oxagen route [M]; OpenAI base-URL option exists [AI] | No pre-action hook documented in its options [AI] | No documented pre-action approval adapter [AI] | Not implemented; a future proxy route could gate model calls [AI], [B] | Not implemented [M] | No Oxagen contained tier [T] |

[C]: ../../packages/tacho/src/host/settings-writer.ts
[X]: ../../packages/tacho/src/host/codex-writer.ts
[H]: ../../packages/tacho/src/claude-code/hook-client.ts
[U]: ../../packages/tacho/src/claude-code/cursor-adapter.ts
[S]: ../../packages/tacho/src/host/stella-writer.ts
[A]: ../../packages/tacho/src/claude-code/stella-adapter.ts
[M]: ../../packages/tacho/src/host/model-base-url.ts
[B]: ../../packages/tacho/src/collector/model-proxy.ts
[D]: ../../packages/tacho/src/collector/day-spend.ts
[L]: ../../packages/tacho/src/collector/model-allowlist.ts
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

Cursor's adapter refuses an ask because its pre-tool protocol cannot provide the requested approval behavior. Enrollment writes no Cursor model route, so its recorded tool activity does not establish metered spend or a budget ceiling. The per-run budget, the per-day budget (ADR-160) and the workspace model list therefore do not apply to Cursor, and Oxagen does not plan a Cursor model route on the current CLI. Stella's writer routes its Anthropic provider; another provider can bypass that route. Stella supplies no session identifier. The proxy attributes a request only when exactly one Stella session is live on the host. With two or more, it records the call as unattributed and skips the session ceiling in the audited revision. Operators cannot rely on a per-session ceiling for concurrent Stella processes. Stella has no SessionEnd hook, so the collector uses process lifecycle evidence to close its sessions. See the adapters above and [the collector](../../packages/tacho/src/collector/daemon.ts).

### Gemini CLI extension

A new adapter would map vendor hook names and decisions, then add enrollment, registry, and desktop support. BeforeTool can deny a tool; BeforeModel can deny a model request. The documented decision values do not include ask. `GOOGLE_GEMINI_BASE_URL` applies to API-key authentication, while Vertex has a separate override. Do not infer an OAuth route from either setting. Estimate: 5 to 7 engineer-days for an initial adapter and one tested proxy route, including schema changes and regression coverage. This is an estimate, not verified support. [Hooks][G], [configuration][GC].

### Aider extension

Aider exposes conversation-history files and an OpenAI API-base option. Its documented lint and test commands operate after edits, so they cannot enforce a pre-edit refusal. A history tailer plus a routed model endpoint could add partial recording and metering. Estimate: 4 to 6 engineer-days, with tool denial and ask still unsupported. Containment would require a separate OS boundary. No adapter or live enrollment was verified. [Options][AI].

## GitLab

Updated 2026-09-23 for [#3762](https://github.com/macanderson/oxagen/issues/3762). The harness rows above are unchanged. gitlab.com is now a second repository host for steering: a workspace can bind a gitlab.com project as its main repository, and a context record publishes as a merge request on it. Self-managed GitLab is not supported. Every call goes to gitlab.com until a host setting and an outbound-network review exist.

The implementation sits behind one provider seam. [The steering host](../../packages/handlers/src/context.steering.host.ts) reads the provider of the workspace's main binding head and sends every steering call to [the GitHub implementation](../../packages/handlers/src/context.steering.github.ts) or [the GitLab implementation](../../packages/handlers/src/context.steering.gitlab.ts). The GitLab side uses [the `@oxagen/gitlab` client](../../packages/gitlab/src/client.ts): merge requests, commit statuses, repository files, branches and compare, and project hooks. It authenticates with a project access token and addresses the project by its numeric id, so a project moved to another group keeps working.

Evidence in this revision is unit and component tests against an in-memory gitlab.com project ([the fake](../../packages/handlers/src/context.steering.gitlab.test-support.ts)). No live gitlab.com project exercise has been recorded yet. [The exercise script](../../tools/scripts/gitlab-steering-exercise.ts) runs one against a real project with a project access token.

This inventory uses registered capability names. Their source files retain dotted names in [the contract directory](../../packages/oxagen/src/contracts/).

| Current capability or seam | GitLab equivalent | Status |
|---|---|---|
| `get_pr`, `get_pr_diff` | Merge request, diffs, notes | Not implemented. These read GitHub PRs for agents and remain GitHub-only |
| `get_ci_status`, `list_branches` | Commit statuses, pipelines, branches | Not implemented; GitHub-only |
| `open_context_pr`, `get_context_pr`, `merge_context_pr` | Open, read, merge a merge request | Implemented through the provider seam. Checks are commit statuses; the merge squashes with `sha` pinned to the checked head; a proposal records which host issued its number |
| `propose_record`, `revise_context_record`, `publish_context_record`, `set_governance_mode`, `get_steering_freshness` | Branch/file changes and merge history | Implemented through the provider seam. `get_steering_freshness` names the host so the CLI matches a gitlab.com remote, nested groups included |
| `list_proposals`, `dismiss_proposal`, `list_context_records`, `promote_context_record` | Local proposal and record state | Local semantics kept. `dismiss_proposal` closes the merge request and deletes its branch, and leaves alone a PR opened on the other host |
| `propose_agent`, `propose_skill`, `propose_configuration_clone` | Repository commits and merge requests | Implemented through the provider seam |
| `commit_agent_definition`, `update_skill_config` | Repository commits and merge requests | Refused on a GitLab binding with `conflict: repository_host_unsupported` |
| `create_workspace` | Create a workspace with a GitLab main project | Implemented: `mainRepo: { provider: "gitlab", projectPath, token }`, no GitHub installation needed. Accepted only from the web app or the HTTP API outside a chat turn, so a token never enters a transcript |
| `bind_main_repository`, `list_repositories`, `get_main_repository` | Projects, binding lifecycle | Implemented: provider plus project id is the identity; nested groups bind as a full namespace owner |
| `link_repository`, `unlink_repository` | Linked projects | Not implemented. Linking stays GitHub-only |
| `get_repository_tree`, `set_production_branch`, `open_init_pr` | Project tree, branches, merge requests | Refused on a GitLab binding with `conflict: repository_host_unsupported` |
| `attach_github_installation`, `list_github_installations`, `list_installation_repositories` | Token connection and project discovery | `attach_gitlab_project` connects one project with a project access token, verified to be that project's own, stored encrypted; `delete_connection` disconnects it. No project discovery: a project token reaches one project |
| `configure_repo`, `sync_repo`, `pause_repo`, `resume_repo`, `get_repo_metrics` | Connector configuration, sync, local metrics | Not implemented. GitLab has no ingestion connector |
| [App authentication](../../packages/github/src/app-auth.ts), [workspace tokens](../../packages/github/src/workspace-token.ts) | Project access token | [The GitLab credential reader](../../packages/handlers/src/lib/gitlab-credential.ts) decrypts the token for one live connection and fails closed; there is no process-wide fallback token |
| [Webhook ingress](../../apps/api/src/routes/v1/github-webhook.ts), [GitHub ingestion](../../packages/ingestion/src/connectors/github/) | Project webhooks | [`POST /webhooks/gitlab/:connection`](../../packages/handlers/src/gitlab.webhook.ts) checks `X-Gitlab-Token` in constant time, then re-reads the merge request through the API: a merge request closed on GitLab rejects its proposal, a revoked token marks the connection errored, and a project move updates the path label. Duplicate and out-of-order deliveries change nothing twice |

A token GitLab no longer accepts refuses with `conflict: gitlab_credential_rejected`, which names the project and nothing about the token. The app's Repositories page connects and binds a project, and repairs a revoked token with a new one for the same project.

What remains before #3762 closes: a recorded exercise against a real gitlab.com project (workspace creation, bind, proposal, checks, approved merge, steering publication), the GitHub-only capabilities in the table above, and the create-workspace form in the app, which still offers GitHub only.
