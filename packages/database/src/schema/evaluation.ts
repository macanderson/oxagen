import { index, jsonb, numeric, text, uuid } from "drizzle-orm/pg-core";
import { evaluationSchema } from "./_schemas.js";
import { auditMixin, executionStatusMixin, idMixin, orgScopeMixin } from "./_mixins.js";

export const evals = evaluationSchema.table(
  "evals",
  {
    ...idMixin("evl"),
    ...auditMixin(),
    ...orgScopeMixin(),
    name: text("name").notNull(),
    evalType: text("eval_type").notNull(),
    datasetConfig: jsonb("dataset_config").notNull(),
  },
  (t) => ({
    orgIdx: index("evals_org_idx").on(t.orgId, t.workspaceId),
  }),
);

export const evalRuns = evaluationSchema.table(
  "eval_runs",
  {
    ...idMixin("run"),
    ...executionStatusMixin(),
    evalId: uuid("eval_id").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),
    score: numeric("score", { precision: 5, scale: 2 }),
    resultsPayload: jsonb("results_payload").notNull(),
  },
  (t) => ({
    evalIdx: index("eval_runs_eval_idx").on(t.evalId),
    agentVersionIdx: index("eval_runs_agent_version_idx").on(t.agentVersionId),
    statusIdx: index("eval_runs_status_idx").on(t.status),
  }),
);
