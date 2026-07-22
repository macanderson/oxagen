---
# Marketplace — Integrations

- **Route:** `/{orgSlug}/{workspaceSlug}/marketplace/integrations`
- **Nav location:** workspace → footer → Marketplace → tab "Integrations"
- **Priority:** P2
- **Disposition vs today:** Keep + build wizards

## Purpose
The catalog of data connectors that ingest external sources into the knowledge graph. It should be a thin, honest catalog — browse what's available, see delivery method, and hand off to a single governed setup wizard — not a front-line breadth play (connector breadth is a deliberate fast-follow, per `docs/VISION.md`). Today it correctly enumerates every registered connector but only GitHub gets an in-app setup flow; everything else punts to "Set up via API" docs, which is invisible and unauditable for non-technical admins.

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin provisioning a new data source
- **JTBD:**
  - Browse every available connector with its delivery method (webhook/polling/SQL/OAuth) at a glance
  - Launch a governed setup flow for any connector, not just GitHub
  - Land on the same connect experience regardless of which connector card was clicked

## Functionality
- **Card grid** (existing, keep): one card per connector from the code-level registry (`listConnectors()` from `@oxagen/ingestion/connectors`), icon, delivery-method badge, description.
- **Fix — universal wizard link:** every card's action button should launch the shared Connect-a-source wizard at `knowledge/sources/connect?connector=<id>` (see that page's spec) instead of branching on an `IN_APP_SETUP` allow-list (currently only `github`) that sends non-GitHub connectors to a `docsUrl()/integrations/<id>` external link. Once the wizard (a contract-schema-driven form + preview + entity-mapping review) covers a connector's config schema via `plugin.schema.get`, retire the docs-link fallback for that connector.
- Existing "Connect" CTA already deep-links to `Knowledge → Repos` with a `?setup=` query param — retarget that deep link to the new `knowledge/sources/connect` route as the wizard is built out (cross-link, don't duplicate the flow here).

## Capabilities invoked
- `integration.install` (`install_integration`) — provisioning a connector instance once the wizard collects config.
- `integration.list` (`list_integrations`) — existing/active connections (surfaced under Knowledge → Repos, cross-linked from here).
- `plugin.schema.get` (`get_plugin_schema`) — drives the wizard's generated config form per connector.
- Connector registry read (`listConnectors()`, code-level, not a contract) — populates this catalog grid.

## Data sources
Postgres → Neo4j (ingestion, async via Inngest) → ClickHouse (ingestion telemetry) dual-write, per the Connector Dual-Write exception in the infrastructure boundaries.

## States
- **Empty:** not applicable — the registry always has entries; a search/filter with no matches shows "No connectors match."
- **Loading:** skeleton cards (registry read is synchronous/code-level so this is typically instant).
- **Error:** wizard launch failure (e.g. missing schema) falls back to the docs link with an inline note, not a dead click.

## Existing implementation
- **Today:** COMPLETE but narrow — full catalog render from the connector registry; only GitHub (`repo.*` capabilities) has an in-app wizard via `Knowledge → Repos`. Every other connector links out to docs. Fix: replace the `IN_APP_SETUP` allow-list branch with a universal link into the shared Connect-a-source wizard.

## Vision alignment
Connector breadth is explicitly a fast-follow, not the wedge — keep this catalog thin and route every card into the governed grounding wizard (BYOK neutrality + graph grounding, wedges 3–4) rather than competing on connector count.
