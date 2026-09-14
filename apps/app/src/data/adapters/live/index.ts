// The live data source: one adapter per port. Only src/data/source.ts imports it.
import "server-only";
import type { DataSource } from "@/data/ports";
import { liveRuns } from "./runs";
import { liveApprovals } from "./approvals";
import { liveAgents } from "./agents";
import { liveIam } from "./iam";
import { liveTools } from "./tools";
import { liveOntology } from "./ontology";
import { liveSteering } from "./steering";
import { liveSpend } from "./spend";
import { liveOrg } from "./org";
import { liveBilling } from "./billing";
import { liveAudit } from "./audit";
import { liveShell } from "./shell";
import { liveOnboarding } from "./onboarding";

export const liveSource: DataSource = {
  runs: liveRuns,
  approvals: liveApprovals,
  agents: liveAgents,
  iam: liveIam,
  tools: liveTools,
  ontology: liveOntology,
  steering: liveSteering,
  spend: liveSpend,
  org: liveOrg,
  billing: liveBilling,
  audit: liveAudit,
  shell: liveShell,
  onboarding: liveOnboarding,
};
