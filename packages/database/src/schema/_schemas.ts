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
