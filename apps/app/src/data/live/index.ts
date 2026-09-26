// The live DataSource: every port method is a kernelRead plus a typed mapper
// (ARCHITECTURE.md §3.3). src/data/source.ts is its only importer.
import type { DataSource } from "@/data/ports";
import { agents } from "./agents";
import { approvals } from "./approvals";
import { audit } from "./audit";
import { billing } from "./billing";
import { conversations } from "./conversations";
import { interjections } from "./interjections";
import { mandates } from "./mandates";
import { onboarding } from "./onboarding";
import { org } from "./org";
import { pretenant } from "./pretenant";
import { runs } from "./runs";
import { runtimes } from "./runtimes";
import { shell } from "./shell";
import { skills } from "./skills";
import { spend } from "./spend";
import { steering } from "./steering";
import { tools } from "./tools";

export const liveSource: DataSource = {
  pretenant,
  shell,
  conversations,
  runs,
  approvals,
  interjections,
  agents,
  mandates,
  billing,
  onboarding,
  org,
  spend,
  audit,
  skills,
  steering,
  tools,
  runtimes,
};
