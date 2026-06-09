# AGENTS.md

Enterprise agent platform. Monorepo. Built around three primitives:
**semantic knowledge**, **execution lineage**, **observable runtime behavior**.

## Hard rules

1. **Capabilities are defined once.** A capability surfaces to the API, the
   MCP server, and the in-app QA agent from a single source. If you find
   yourself implementing the same capability twice, stop and extract it.
2. **Storage boundaries are not negotiable.** See CLAUDE.md for the full
   matrix. Summary: Neo4j = ontology/lineage/memory, Postgres = transactional
   state, ClickHouse = append-only runtime events. Never put analytics in
   Neo4j; never put graph relationships in Postgres.
3. **Executions are first-class entities.** Every run is queryable and
   connects to the agents, workflows, tools, documents, ontology nodes,
   artifacts, and external systems it touched. Lineage must be explainable
   after the fact.
4. **Shared logic lives in `/packages`.** Apps must not duplicate platform
   code. If two apps need the same thing, it belongs in a package.
5. **Critical paths emit logs, metrics, traces, and lineage.** A failure
   should be diagnosable from telemetry alone — no attaching a debugger.

## Layout

```
/apps      customer-facing applications
/packages  shared platform libraries (single source of truth for platform code)
/tools     internal dev tooling and CLIs
```

### Apps

- `mcp` — MCP server exposing platform capabilities
- `api` — HTTP API exposing the same capabilities
- `app` — web app; hosts the interactive enterprise AI platform
- `cli` — Commander + Ink CLI; `apps/cli/src/index.tsx`. Ships 95 command files covering auth, orgs, workspaces, chat, conversations, API keys, plugins, billing, agents, workflows, images, documents, automation, forms, skills, and user preferences. `oxagen dev` is the dev-stack launcher and port-prober.
- `docs` — Fumadocs/MDX documentation site; statically generated, deployed as `oxagen-v2-docs.vercel.app`

## When adding a capability

1. Define it in `/packages` once.
2. Wire it into `apps/mcp`, `apps/api`, and the `apps/app` enterprise AI platform.
3. Emit logs/metrics/traces and write execution lineage to Neo4j.
4. Store transactional state in Postgres, runtime events in ClickHouse.
