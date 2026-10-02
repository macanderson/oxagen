# ADR-209: A migrated workspace's tool registry is written from its steering repo

- **Status:** Accepted (amended by ADR-211: the migration moves streamable-http rows only, and an sse row stays a legacy row that no longer holds a workspace on direct writes, and by ADR-245: `migrate_tools_to_steering` and steering repo provisioning start the migration)
- **Date:** 2026-09-27
- **Owners:** tools, steering
- **Related:** issue #4478 (lane M13), PR #4480, PR #4472 (S5 publish),
  ADR-187 (steering record is the only name for the records that steer an
  agent), ADR-097 (steering and gating are two planes).

## Context

A workspace's connected MCP servers live in `mcp.mcp_servers`, and their tools
in `agent.tools` and `agent.tool_versions`. Three capabilities write those rows
directly: `register_mcp_server`, `set_plugin_enabled` and `import_tools`. The
steering repo holds a `tools/servers/<name>/` folder per server, with
`server.toml`, `tools.toml` and `tools.lock.json`, and a publish compiles the
merged repo into a version. Until this record, nothing connected the two, so a
server could exist in the registry with no folder and a folder could exist with
no row.

The folder is committed to git. A secret in a server's URL or auth config
cannot move into it, and a `stdio` server runs as a local process that a
folder's remote source cannot reach.

## Decision

1. **Publishing writes the registry.** `project(bundle, { folders?, now? })` in
   `packages/handlers/src/mcp-studio/project.ts` writes a published version's
   servers and tools into the registry in one transaction that holds the
   workspace rule lock. S5's `publish()` calls it through the deps that
   `withToolProjection` (`mcp-studio/publish-deps.ts`) builds, because
   `@oxagen/steering-bundle` cannot import the handlers. A server folder is one
   `mcp.mcp_servers` row found by `steering_name`. A tool is one `agent.tools`
   row whose slug is `<folder>__<key>`. A definition hash the tool has never
   carried publishes a new version, and a hash one of its versions already
   carries makes that version active again, so a restore rolls a tool back.
2. **A row records where it came from.** `mcp.mcp_servers.origin` is `legacy`
   (written directly, every row before this record), `steering` (written by a
   publish), or `proposed` (a server a steering PR adds, off until the PR
   merges). The first publish that lists a folder a `legacy` or `proposed` row
   names takes that row over. The row keeps its id, so the consents and tool
   snapshots keyed on it survive, and it keeps its auth. A taken-over proposal
   is turned on.
3. **A folder that leaves the version retires its rows.** A tool its folder no
   longer lists is disabled. A folder the version no longer holds soft-deletes
   its server and disables that server's tools. A folder present at the commit
   but missing from the manifest failed to compile, so its rows are left as
   they are.
4. **The in-app agent does not load a steering row.**
   `selectMaterializableMcpServers` skips origin `steering`, so the in-app
   agent and `get_agent_toolbelt` agree on which servers an agent has.
5. **The migration moves the servers a folder can hold.** `migrate()` in
   `packages/handlers/src/mcp-studio/migrate.ts` moves every live, enabled,
   legacy row whose transport is `streamable-http` or `sse`. It leaves behind,
   and lists in the PR body, a `stdio` row, a row whose URL is not http or
   https, a row whose URL has a query string, and a row whose auth has no
   `server.toml` form. Every credential in a folder is a placeholder
   `oxagen:credential/<name>`, and the secret stays on the row. A steering PR
   holds at most 299 files, and a batch never splits a folder.
6. **The direct paths open steering PRs once a workspace has migrated.**
   `steeringWriter(workspace)` in `packages/agent/src/runtime/steering-pr.ts`
   returns a writer only when boot registered an opener and a writer, the
   workspace has a steering repo, and no row the migration would move is left.
   Until then every path writes rows as before. With the writer on:
   - `register_mcp_server` and `set_plugin_enabled` write a remote server as a
     disabled `proposed` row and open a PR that adds its folder. The writer
     reserves the folder name on the row before the PR opens, so the unique
     index on `(workspace, steering_name)` settles a race, and releases it when
     the PR does not open. A server the folder cannot hold is refused with
     `server_not_movable`, since a new legacy row would put the workspace back
     on direct writes.
   - `import_tools` opens a PR that appends pinned tools to a steering
     server's `tools.toml` and lock, and refuses hand-authored declarations for
     that server.
   - A plugin the repo already holds is still toggled on and off directly.
   - The OAuth sign-in (`authorize_mcp_server`, and `start_mcp_authorization`
     when a stored token still works) stores the tokens, then decides the row
     as `set_plugin_enabled` does. Both call `proposeListingServer` in
     `packages/agent/src/runtime/steering-proposal.ts`. The sign-in pins the
     tools it listed before the PR opens, so the folder lists them. A server
     whose steering PR is open is refused with `steering_pr_open`, and the
     tokens stay stored. (Added 2026-10-01, #4478.)
7. **Consequence tags are called impacts.** `consequence_tags` is renamed to
   `impacts` on `agent.tool_versions` and `tools.mandates`, and in every
   contract. The tool checksum keeps `consequence_tags` as its input key, so no
   stored checksum changes.

## Consequences

- The steering repo is the one record of a migrated workspace's remote
  servers. A change to them is a steering PR.
- A server connected after migration is off until its PR merges and the next
  publish runs. Closing the PR unmerged leaves the proposed row off with its
  folder name, and `set_plugin_enabled` refuses that plugin with
  `steering_pr_open` until someone deletes the row. Nothing detects the closed
  PR yet.
- A `stdio` server stays a legacy row, and each remote row the migration left
  behind keeps the workspace on direct writes until someone fixes, disables,
  or deletes it.
- A tool added through a steering PR is unclassified: risk high, side effect
  write, egress third party, until someone edits its `tools.toml` entry.
- A plugin added through a steering PR before Oxagen probed it adds a folder
  with no tools. Its tools arrive when the folder's sync (M4) fills them in.
- `project()` writes `measures: {}` on each version, and a change to a
  version's risk grade alone does not bump the deny generation.
- Boot registration is M11's work. Until M11 registers the opener and calls
  `registerServerFolderWriter(createServerFolderWriter())`, `migrate()` throws
  `steering_pr_unavailable` and every direct path writes rows.
