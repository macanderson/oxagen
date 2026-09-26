// schemas.ts: every schema this module defines, by its contract id, with the
// title and description its published JSON Schema carries.
import type { z } from "zod";
import { agentSchema } from "./agent";
import { bundleSchema } from "./bundle";
import { governanceSchema } from "./governance";
import { promotionSchema } from "./promotion";
import { steeringRecordSchema } from "./record";
import { reflectionSchema } from "./reflection";
import type { SteeringRepoSchemaId } from "./schema-ids";
import { toolbeltSchema } from "./toolbelt";
import { workspaceSchema } from "./workspace";

export interface SchemaEntry {
  id: SteeringRepoSchemaId;
  title: string;
  description: string;
  schema: z.ZodTypeAny;
}

/** One entry per id in STEERING_REPO_SCHEMA_IDS, in the same order. */
export const STEERING_REPO_SCHEMAS: readonly SchemaEntry[] = [
  {
    id: "steering-record/v1",
    title: "Steering record frontmatter",
    description:
      "The YAML frontmatter of a steering record: a Markdown file under steering/ in a steering repo.",
    schema: steeringRecordSchema,
  },
  {
    id: "workspace/v1",
    title: "Workspace",
    description:
      "workspace.toml at the root of a steering repo: linked code repositories, the budget, code checks, tools, and embeddings.",
    schema: workspaceSchema,
  },
  {
    id: "agent/v1",
    title: "Agent",
    description:
      "One file per agent in agents/: its operator, runtime, and harness. Cedar reads it as the principal.",
    schema: agentSchema,
  },
  {
    id: "governance/v1",
    title: "Governance",
    description:
      "steering/governance.toml: the governance mode, the always-on budget, the ledger, memory settings, and reviewer groups.",
    schema: governanceSchema,
  },
  {
    id: "toolbelt/v1",
    title: "Toolbelt",
    description:
      "A named toolbelt in tools/toolbelts/: tools across servers that an agent or a run may use.",
    schema: toolbeltSchema,
  },
  {
    id: "reflection/v1",
    title: "Reflection",
    description:
      "The memory an agent writes at the end of a run, with grades for the work and its tools. Oxagen stores it.",
    schema: reflectionSchema,
  },
  {
    id: "promotion/v1",
    title: "Ledger line",
    description:
      "One line of steering/promotions/<period>.jsonl: a merged steering PR, chained to the line before it by hash.",
    schema: promotionSchema,
  },
  {
    id: "bundle/v1",
    title: "Published bundle",
    description:
      "What the cloud gateway and session start read for one published version of a steering repo.",
    schema: bundleSchema,
  },
];

/** The zod schema for one contract id. */
export function schemaFor(id: SteeringRepoSchemaId): z.ZodTypeAny {
  return (STEERING_REPO_SCHEMAS.find((entry) => entry.id === id) as SchemaEntry)
    .schema;
}
