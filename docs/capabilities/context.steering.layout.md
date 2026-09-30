# get_steering_layout

Read which layout the workspace's bound repository uses: `steering` or `legacy`.

**Surfaces:** api, mcp, agent

POST `/v1/context/steering/layout` with an empty body. The response is `{ "layout": "steering" | "legacy" | null }`.

A repository whose production branch carries `steering/governance.toml` is a steering repository. `open_context_pr` writes a new record under `steering/<kind folder>/`, or `steering/memory/workspace/general/` for a memory, on branch `steering/<lineage>` or `memory/<lineage>`. Any other repository is legacy. `open_context_pr` writes `.oxagen/rules/<lineage>.toml` on branch `steering/<lineage>`.

The read is the one `open_context_pr` makes before it writes, so a preview built from it names the path and branch the pull request will use. `layout` is null when no repository is bound or the read fails. A client shows no path in that case and does not guess one.

The create wizard reads it to preview a new record's file and branch. Every workspace role may call it, and it consumes no credits.
