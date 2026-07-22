import { pgSchema } from "drizzle-orm/pg-core";

// One Postgres schema per spec §6 domain. Drizzle's `pgSchema` namespace
// keeps domain boundaries explicit at the table level — no cross-domain
// foreign-key shortcuts inside table builders; the relations file ties
// things together.
export const authSchema = pgSchema("auth");
export const orgSchema = pgSchema("org");
export const workspaceSchema = pgSchema("workspace");
export const agentSchema = pgSchema("agent");
export const workflowSchema = pgSchema("workflow");
export const chatSchema = pgSchema("chat");
export const contentSchema = pgSchema("content");
export const billingSchema = pgSchema("billing");
export const securitySchema = pgSchema("security");
export const mcpSchema = pgSchema("mcp");
export const pluginSchema = pgSchema("plugin");
export const notificationSchema = pgSchema("notification");
export const ingestionSchema = pgSchema("ingestion");
export const iamSchema = pgSchema("iam");
// evidence — the immutable governed-run evidence domain
// (docs/specs/run-evidence-ingress/spec.md). Isolated from `agent` on purpose:
// these rows are chain-of-custody records with append-only grants (SELECT +
// INSERT, never UPDATE/DELETE for the application role) and their own retention
// administration path, so keeping them in a dedicated schema makes the
// privilege boundary a schema-level fact rather than a per-table convention.
// The foundation lands `retention_policy_versions` here; the manifest/blob
// ledger follows in the evidence-ledger PR. See schema/run-evidence-foundation.ts.
export const evidenceSchema = pgSchema("evidence");
export const privacySchema = pgSchema("privacy");
export const schemaRegistrySchema = pgSchema("schema_registry");
export const environmentsSchema = pgSchema("environments");
export const aiSchema = pgSchema("ai");
export const evalSchema = pgSchema("eval");
// cms — public marketing/content surface (website lead capture + gated ebook
// access). Not tenant-scoped: leads are prospects, not org members, so these
// tables use bypass-only RLS and are written through withSystemDb, never a
// tenant query. See schema/cms.ts.
export const cmsSchema = pgSchema("cms");
// ratelimit — cross-cutting abuse-control counters for the distributed API rate
// limiter. Isolated in its own schema (like `security`) so this hot, ephemeral,
// high-churn data can be vacuumed/backed-up independently of operational state,
// and so a tenant query can never read another org's counters. Not tenant-
// scoped (counters key on org OR workspace OR IP); bypass-only RLS, written
// exclusively through withSystemDb. See schema/ratelimit.ts.
export const ratelimitSchema = pgSchema("ratelimit");
