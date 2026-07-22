---
# Connect a source

- **Route:** `/{orgSlug}/{workspaceSlug}/knowledge/sources/connect`
- **Nav location:** reached from Sources "Connect a source" CTA, and from Marketplace → Integrations
- **Priority:** P1
- **Disposition vs today:** New

## Purpose
A governed, multi-step wizard that takes a workspace member from "pick a connector" to "agents can cite this data" without leaving the app. Today only GitHub has an in-app flow (`repo.*` capabilities); every other connector in the marketplace punts the user to "set up via API," which is invisible, unauditable, and blocks non-technical admins. This wizard turns any installed plugin's typed config schema into a real UI form and a reviewed entity-mapping step, closing the gap between "connector exists" and "connector is usable."

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin provisioning a new data source
- **JTBD:**
  - Pick a connector from the installed/available catalog
  - Enter credentials via a form generated from the connector's own schema, with inline validation
  - Preview a sample of records before committing to ingestion
  - Review and edit LLM-suggested entity-type mappings, then confirm to activate

## Functionality
- **Step 1 — Pick connector:** grid/list of installed plugins (from the marketplace catalog); OAuth connectors redirect out and return via `?connectionId=`.
- **Step 2 — Credentials:** form rendered dynamically from `plugin.schema.get`'s JSON-schema-like config shape; per-field inline validation errors from `plugin.schema.validate`.
- **Step 3 — Preview:** sample records fetched via `connection.preview` before any commitment, so bad credentials or wrong scopes surface early.
- **Step 4 — Mappings:** LLM-suggested entity-type/property mappings (`connection.mappings.suggest`), rendered editable; user adjusts, then confirms.
- **Step 5 — Confirm:** `connection.mappings.set` persists the mapping and activates the connection, kicking off async ingestion. Wizard redirects to `/knowledge/sources` with the new connection visible and syncing.
- Back/forward step navigation preserves entered state; abandoning mid-wizard leaves no partial connection.

## Capabilities invoked
- `connection.create` (`create_connection`) — provisions the connection record.
- `connection.preview` (`preview_connection`) — sample-record preview step.
- `connection.mappings.suggest` (`suggest_connection_mappings`) — LLM-suggested mappings.
- `connection.mappings.get` (`get_connection_mappings`) — reload mappings on wizard resume.
- `connection.mappings.set` (`set_connection_mappings`) — confirm + activate.
- `plugin.schema.get` (`get_plugin_schema`) — renders the credential form.
- `plugin.schema.validate` (`validate_plugin_schema`) — inline field validation.
- `integration.install` (`install_integration`) — installs the connector plugin if not yet installed.
- `integration.configure` (`configure_integration`) — integration-level settings alongside the connection.

## Data sources
Postgres (connection + encrypted credentials, operational record) → Neo4j (async Inngest ingestion of entities/relationships) → ClickHouse (ingestion telemetry) — the Connector Dual-Write pattern.

## States
- **Empty:** connector catalog step defaults to "no connector selected," CTA disabled until one is picked.
- **Loading:** each step shows a skeleton while its capability call resolves (schema fetch, preview fetch, mapping suggestion).
- **Error:** credential validation errors render inline per field; preview failure shows a retry with the raw connector error message, not a generic failure.

## Existing implementation
- **Today:** no general wizard exists. Only `repo.*` (GitHub) has an in-app connect flow; every other connector shows a "Set up via API" dead end. Build new.

## Vision alignment
Connector breadth itself is a fast-follow, not the wedge — but a governed, schema-validated, mapping-reviewed ingestion path is what makes every connector actually deepen the grounding moat instead of sitting unused; P1 because without this wizard the marketplace's connector catalog is decorative.
