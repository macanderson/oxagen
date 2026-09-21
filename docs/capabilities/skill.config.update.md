# update_skill_config

Use `action: propose` with TOML `text` to open a pull request. Use `action: publish` with `pullRequestNumber` after it merges into the approved production branch. Publication reads the merge commit again and records its digest. `action: import` reads the existing production branch once per repository binding; later versions require a merged pull request. A retry of the same commit returns its existing version.

**Mode:** sync

**Surfaces:** api, mcp

- API: `POST /v1/:org_slug/:workspace_slug/skills/config/update`
- MCP: `update_skill_config`
- Roles: Organization Owner or Admin. API keys act as their recorded creator.
- Billing: `noBillingGate: true`.

The handler checks the role on every plan. Configuration comes only from the approved main repository binding. The live GitHub default branch cannot change the configured production branch. Historical snapshots are append-only and remain available after a later publication.

See [the version 1 configuration format](../specs/skill-resolution-config.md). This is the configuration and human preview increment of #3098. Agent run pinning, belt injection, interjections, reflection quarantine and the Steering console remain separate integration work. Oxagen resolves skills; the harness runs them.

## App

Open Steering > Skills. Versions shows published history and an editable TOML draft. Opening a PR does not publish it. An organization owner or admin imports repository settings or publishes a verified merged PR.
