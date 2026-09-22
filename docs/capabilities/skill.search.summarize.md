# summarize_skill_search

The agent's read of the resolution `preview_skill_search` answers for a person. Provide a published `version` and a `query`. It returns the skills the configuration approves for loading, their scores and the cumulative token estimate, and it counts the withheld skills by reason. A withheld skill's id, source, version and digest are absent from the output shape, so no caller of this capability can learn which skills it was not approved to find.

**Mode:** sync

**Surfaces:** mcp

- MCP: `summarize_skill_search`
- Roles: Owner, Admin or Member in the organization, or Owner or Member in the workspace. API keys act as their recorded creator.
- Billing: `noBillingGate: true`.

Both skill-search capabilities run the same role gate, read the same published snapshot and the same repository commit, and resolve through the same function. They differ only in what they return, which is why the withheld projection a person may see has no MCP surface to reach an agent through. See [`preview_skill_search`](skill.search.preview.md) for the person's projection and [the version 1 configuration format](../specs/skill-resolution-config.md) for the configuration.

This capability previews a published configuration. It loads nothing into a run and meters nothing. Agent run pinning, belt injection and the metered `search_skills` tool a run pays for remain separate work under ADR-090.
