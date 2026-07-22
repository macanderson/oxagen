---
# Sources

- **Route:** `/{orgSlug}/{workspaceSlug}/knowledge/sources`
- **Nav location:** workspace → Knowledge → tab "Sources"
- **Priority:** P1
- **Disposition vs today:** Rename

## Purpose
The workspace's list of authenticated data connections that feed the knowledge graph — databases, SaaS APIs, file drops, and code repos alike. Today this lives at `knowledge/repos`, a name inherited from when GitHub was the only connector; it now misleads, since most connections are not git repos at all. Renaming to "Sources" makes the page legible as the entry point to grounding: connect a source, and agents gain cited access to its data.

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin or data owner provisioning agent knowledge
- **JTBD:**
  - See every connected source at a glance: type, health, last sync, node count
  - Pause, resume, edit, or delete a connection without losing ingestion history
  - Diagnose a stalled or unhealthy sync from the same list
  - Launch the connect-a-source wizard for a new integration

## Functionality
- Connection cards/table: name, connector type + icon, status (active/paused/error), health indicator, last sync timestamp, ingested node count.
- Row actions: Pause, Resume, Edit (opens mapping/config), Delete — three delete modes (soft-disconnect keeping graph data, disconnect + purge graph nodes, disconnect + retain-and-archive).
- "Connect a source" CTA → `/knowledge/sources/connect` wizard.
- Post-OAuth return handling via `?setup=<connector>&connectionId=<id>` query params, resuming the wizard's mapping step in-place.
- Per-connection detail drawer: integration metrics (records synced, error count, last error message).

## Capabilities invoked
- `connection.list` (`list_connections`) — populate the card list.
- `connection.get` (`get_connection`) — connection detail drawer.
- `connection.update` (`update_connection`) — edit connector config.
- `connection.pause` (`pause_connection`) — pause/resume toggle.
- `connection.delete` (`delete_connection`) — the three delete modes.
- `integration.list` (`list_integrations`) — installed integration catalog backing each connection.
- `integration.get` (`get_integration`) — integration detail.
- `integration.metrics` (`get_integration_metrics`) — sync health stats shown in the drawer.
- `integration.sync` (`sync_integration`) — manual re-sync trigger.
- `integration.configure` (`configure_integration`) — integration-level settings.
- `integration.delete` (`delete_integration`) — uninstall an integration entirely.

## Data sources
Postgres (connection record: credentials, sync cursor, health — source of truth) + Neo4j (graph index of ingested entities/relationships, written async via Inngest).

## States
- **Empty:** no connections yet — full-bleed "Connect your first source" CTA.
- **Loading:** `TableSkeleton` behind Suspense while `connection.list` streams in.
- **Error:** `connection.list` failure renders empty state (fail-open), logs server-side; never blocks the header.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/knowledge/repos/page.tsx` is COMPLETE — Suspense-streamed `ConnectionsSection` + `KnowledgeConnectionsClient`, wizard entry via `?setup=`/`?connectionId=`. Rename directory `repos` → `sources` and update `@/lib/routes` + nav label; no rebuild needed. Reverse-parity note: `connection.*` capabilities are invoked here but their contracts omit `app` from `layers[]` — declare it so `check:ui-parity` stops flagging a false gap.

## Vision alignment
Sources is the intake for the graph-grounding moat — every cited answer traces back to a connection listed here; P1 because ungoverned or invisible ingestion undermines the accuracy story before it starts.
