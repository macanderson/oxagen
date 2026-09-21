# get_skill_config

Read the published configuration and its version history. `version` selects an earlier public id or version label. With no published version, the result has `enabled = false`.

**Mode:** sync

**Surfaces:** api, mcp

- API: `POST /v1/:org_slug/:workspace_slug/skills/config`
- MCP: `get_skill_config`
- Roles: Owner, Admin or Member in the organization, or Owner or Member in the workspace. API keys act as their recorded creator.
- Billing: `noBillingGate: true`.

The handler checks the role on every plan. Configuration comes only from the approved main repository binding. The live GitHub default branch cannot change the configured production branch. Historical snapshots are append-only and remain available after a later publication.

See [the version 1 configuration format](../specs/skill-resolution-config.md). This is the configuration and human preview increment of #3098. Agent run pinning, belt injection, interjections, reflection quarantine and the Steering console remain separate integration work. Oxagen resolves skills; the harness runs them.
