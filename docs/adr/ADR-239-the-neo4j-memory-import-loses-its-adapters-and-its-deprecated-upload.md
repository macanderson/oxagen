# ADR-239: The Neo4j memory import loses its adapters and its deprecated upload

- **Status:** Accepted
- **Date:** 2026-10-01
- **Owners:** steering
- **Related:** issue #4907 (lane IMP1 of the memory collection plan), PR #4928,
  `DEREGISTERED.md` §8 and §13, issue #4179.

## Context

`parse_memory_import` and `commit_memory_import` split Markdown into Neo4j
assistant memories. `DEREGISTERED.md` §8 retired both on 2026-09-16, and both
stayed registered and served on the api, mcp, and agent surfaces. Mac decided
on 2026-09-28 that you can bulk import Markdown files as steering records or
as Cedar policies, and on 2026-09-30 that the importer classifies what it
imports and grades its enforcement. `parse_markdown_import` and
`commit_markdown_import` (#4928) do that, and replace the pair.

PR #4928 takes the old pair off every surface and removes its handler
registrations, the second and third levers in `DEREGISTERED.md` §1. Two kinds
of file cannot stay once the contracts declare `surfaces: []`:

- **The MCP tools.** xmcp serves every file under `apps/mcp/src/tools/`, and
  `apps/mcp/src/tools/tool-registry.test.ts` requires the tool files to name
  exactly the contracts on the `mcp` surface. A tool file for a contract on no
  surface fails that test, and served, it would answer `surface_denied` on
  every call.
- **The API routes and the deprecated upload.** A route for a contract on no
  surface, or a server action that invokes a capability with no handler,
  answers an error on every call. `apps/app_deprecated`'s Bulk Import sheet
  called the pair through two server actions, so the sheet would fail with
  `no_handler` for anyone who opened it.

`DEREGISTERED.md` §1 says nothing it lists leaves the tree without an ADR that
names it. This is that ADR.

## Decision

Delete these files:

- `apps/api/src/routes/v1/agent.memory_import.parse.ts` and
  `apps/api/src/routes/v1/agent.memory_import.commit.ts`, with their mounts in
  `apps/api/src/app.ts` and their rows in
  `apps/api/src/routes/v1/thin-capability-routes.test.ts`.
- `apps/mcp/src/tools/agent.memory_import.parse.ts` and
  `apps/mcp/src/tools/agent.memory_import.commit.ts`.
- `apps/app_deprecated/src/app/[orgSlug]/[workspaceSlug]/knowledge/memory/bulk-import-actions.ts`
  and its test. `memories-section.tsx` stops passing `parseImport` and
  `commitImport`, so the Memories list shows no Bulk Import button.

Keep everything else, unreachable:

- the contracts `packages/oxagen/src/contracts/agent.memory_import.parse.ts`,
  `agent.memory_import.commit.ts`, and `agent.memory_import.shared.ts`, which
  `DEREGISTERED.md` §14 preserves, on no surface;
- the handlers `packages/agent/src/handlers/agent.memory_import.parse.ts` and
  `agent.memory_import.commit.ts`, and the splitter in
  `packages/agent/src/memory/import.ts`, with no registration;
- the deprecated app's `memories-bulk-import.tsx`, which renders only when a
  caller passes both actions.

`packages/handlers/src/capability-dispatch.probe.test.ts` names the two
retired capabilities in `NO_HANDLER_OK`, the one place that allows a contract
with no handler, and only for a capability `DEREGISTERED.md` retires this way.

## Consequences

- No route, tool, agent turn, or page reaches the Neo4j import. `oxagen memory
  import` calls `parse_markdown_import` and `commit_markdown_import`.
- `DEREGISTERED.md` §8 records the pair's parity as `C___` and cites this ADR,
  and §13 lists the deleted files.
- Issue #4179 planned to reuse the old pair from the assistant. It calls the
  new pair instead, which is on the agent surface.
- The Import Markdown dialog on the Steering page (lane IMP2, #4913)
  replaces the deprecated upload. Until it ships, the app has no screen for
  the import.

## Alternatives

- **Keep the adapter files unmounted.** Rejected: xmcp serves any file in the
  tools folder, so an MCP tool cannot be unmounted, and the registry test
  fails on it. An unmounted route is code nothing reaches.
- **Keep the pair on its surfaces.** Rejected: the pair is retired in
  `DEREGISTERED.md`, writes embedded Neo4j memories that Mac ruled out on
  2026-09-30, and resets a memory's class and score when a file is imported
  again.
- **Point the deprecated upload at the new pair.** Rejected: the new pair
  answers records and policies and opens a steering PR, so the sheet's draft
  grid would need a rewrite for an app that is deprecated. IMP2 builds the
  import on the current app.
