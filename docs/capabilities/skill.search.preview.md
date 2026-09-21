# preview_skill_search

Provide a published `version` and a `query`. The preview reads the approved repository head once and returns that commit id. It evaluates those files against the selected configuration, withholds out-of-scope and changed-digest files before ranking, and applies the cutoff, result limit and cumulative token budget. A person can inspect withheld names; the agent projection contains only counts and reason classes. No skill is loaded and no model is called.

**Mode:** sync

**Surfaces:** api, mcp

- API: `POST /v1/:org_slug/:workspace_slug/skills/search/preview`
- MCP: `preview_skill_search`
- Roles: Owner, Admin or Member in the organization, or Owner or Member in the workspace. API keys act as their recorded creator.
- Billing: `noBillingGate: true`.

The handler checks the role on every plan. Configuration comes only from the approved main repository binding. The live GitHub default branch cannot change the configured production branch. Historical snapshots are append-only and remain available after a later publication.

See [the version 1 configuration format](../specs/skill-resolution-config.md). This is the configuration and human preview increment of #3098. Agent run pinning, belt injection, interjections, reflection quarantine and the Steering console remain separate integration work. Oxagen resolves skills; the harness runs them.

The server coalesces catalog reads for the same repository binding, immutable commit, and source name. It retains at most eight catalogs per process and drops failed reads. A new commit or binding gets a new read. Credential resolution uses the approved binding's connection and refuses a shared-token fallback for that connection.
