# ADR-247: `oxagen memory` reads workspace memories

- **Status:** Accepted. The agent building lane MEM5 chose this. Mac has not
  ruled on it, and the memory collection spec lists the CLI name as an open
  question.
- **Date:** 2026-10-01
- **Owners:** steering, cli
- **Related:** issue #4912 (lane MEM5), ADR-238, ADR-239, ADR-245, the memory
  collection spec (`memory-collection-spec.html` in oxageninc/roadmap,
  sections Capabilities and Open questions).

## Context

`oxagen memory list|show|edit|salience|promote|demote|dismiss|candidates|citations|rm`
and `oxagen remember` read and wrote the in-app assistant's memory store,
the `:AgentMemory` nodes in Neo4j. The workspace memories Oxagen collects from
enrolled hosts live in `agent.memories` in Postgres, and no command read them.
The memory collection spec points `oxagen memory` at workspace memories. One
noun on two stores would list memories that `oxagen memory promote` cannot
promote, and promote memories that `oxagen memory list` does not show.

## Decision

1. **`oxagen memory list|show|promote|dismiss` read and write workspace
   memories** through `list_workspace_memories`, `get_workspace_memory`,
   `promote_memories`, and `dismiss_memories`.
2. **The assistant store's commands go.** `oxagen memory edit`, `salience`,
   `demote`, `candidates`, `citations`, and `rm`, and `oxagen remember`, are
   removed. They are not renamed under another noun.
3. **The assistant store's capabilities stay** on the API and MCP:
   `list_memories`, `save_memory`, `update_memory`, `delete_memory`,
   `promote_memory`, `demote_memory`, `dismiss_memory_promotion`,
   `list_memory_promotions`, and `get_citation_stats`.
4. **`oxagen memory import`** reads Markdown into steering records through
   `parse_markdown_import` and `commit_markdown_import` (ADR-239), unchanged.

## Why removal and not a rename

The spec points `oxagen memory` at workspace memories and proposes that the
Memories tab replace the Library's Memory shelf, the app's view of the
assistant store. A renamed group would keep seven commands and their tests
for a store whose app view the spec proposes to replace. The capabilities stay, so
nothing an agent or a script on the API or MCP depends on changes.

## Consequences

- A script that runs a removed command fails with Commander's unknown-command
  error and exits 1.
- `apps/cli/src/lib/memory-client.ts` keeps its Neo4j client functions,
  which only their own tests call now. A later change removes them.
- To reverse: restore the commands from the commit before #4912 under a new
  noun, such as `oxagen assistant-memory`.
