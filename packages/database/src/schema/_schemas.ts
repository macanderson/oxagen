import { pgSchema } from "drizzle-orm/pg-core";

// One Postgres schema per spec §6 domain. Drizzle's `pgSchema` namespace
// keeps domain boundaries explicit at the table level — no cross-domain
// foreign-key shortcuts inside table builders; the relations file ties
// things together.
export const authSchema = pgSchema("auth");
export const organizationSchema = pgSchema("organization");
export const workspaceSchema = pgSchema("workspace");
export const integrationSchema = pgSchema("integration");
export const agentSchema = pgSchema("agent");
export const workflowSchema = pgSchema("workflow");
export const eventSchema = pgSchema("event");
export const executionSchema = pgSchema("execution");
export const chatSchema = pgSchema("chat");
export const contentSchema = pgSchema("content");
export const graphSchema = pgSchema("graph");
export const evaluationSchema = pgSchema("evaluation");
export const billingSchema = pgSchema("billing");
