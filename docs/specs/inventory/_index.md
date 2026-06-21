# Spec Inventory

Behavioral specs mined from existing code by the `spec-miner` agent (flat OpenSpec `### Requirement:` / `### Invariant:` blocks). Auto-extracted 2026-06-20 at commit `2f628504`. Each file is a baseline for future OpenSpec deltas.

## packages/ai
- [ai-text-generation](ai-text-generation.md) — `streamText`/`generateObject`/`embed` wrappers; metering, duration, surface tagging, prompt hashing to ClickHouse.
- [ai-media-and-models](ai-media-and-models.md) — image/video generation; model catalog & effective-default resolution (`modelIdOf`).

## packages/inngest-functions
- [inngest-agent-execution](inngest-agent-execution.md) — agent fan-out/aggregate, subagent execution, workflow supervisor, graph sync.
- [inngest-ingestion](inngest-ingestion.md) — GitHub sync/parse, ingestion pipeline dual-write, OAuth refresh, semantic-edge inference.
- [inngest-billing-privacy-playbooks](inngest-billing-privacy-playbooks.md) — usage rollup, dunning, Stripe sync, GDPR erasure/export, audit rollover, playbook runs.

## packages/handlers
- [handlers-agent-chat](handlers-agent-chat.md) — agent compose/execution, chat send, conversation lifecycle.
- [handlers-iam-org-workspace](handlers-iam-org-workspace.md) — org/workspace lifecycle, membership, roles, invitations, IAM provisioning, user prefs.
- [handlers-billing-apikeys](handlers-billing-apikeys.md) — credits/subscription, API-key create/rotate/revoke.
- [handlers-connections-integrations](handlers-connections-integrations.md) — connector/integration/repo lifecycle, mappings, sync (Postgres+Neo4j dual-write).
- [handlers-graph-ontology](handlers-graph-ontology.md) — Neo4j node/edge/ingest/cypher, ontology queries, semantic-edge approval.
- [handlers-media-documents](handlers-media-documents.md) — image/video/svg/markdown/mermaid gen, asset persist/serve, documents/PDF, forms.
- [handlers-plugins](handlers-plugins.md) — marketplace browse, org/workspace install & enablement, registry, credentials, schema, entitlements.
- [handlers-skills](handlers-skills.md) — skill edit, versioning, workspace install/list, seeding.
- [handlers-automation-workflow](handlers-automation-workflow.md) — automation lifecycle, workflow run/cancel/status, research swarm.
- [handlers-privacy-audit-web](handlers-privacy-audit-web.md) — GDPR export/erase, audit-log query, notifications, web fetch/search, prompt settings.

## apps/app
- [app-auth-onboarding](app-auth-onboarding.md) — Better Auth login/signup/reset/verify flows, org onboarding.
- [app-api-routes](app-api-routes.md) — `/api/v1` route handlers: chat SSE stream, assets, stripe checkout, avatar upload, plugin catalog, MCP OAuth.
- [app-server-actions](app-server-actions.md) — `"use server"` actions with explicit IAM/tenancy gates over `invoke()`.
- [app-routing-proxy](app-routing-proxy.md) — `proxy.ts` edge interceptor, org/workspace slug resolution, route guarding, sidebar/active-tab.
- [app-lib-domain](app-lib-domain.md) — audit export/filter/query, billing/plan formatting, compliance controls, enterprise/seat gating.
- [app-chat-stream-ui](app-chat-stream-ui.md) — `use-tool-stream.ts` SSE consumer state machine, generative-UI component registry.
