// The live DataSource: every port method is a kernelRead plus a typed mapper
// (ARCHITECTURE.md §3.3). src/data/source.ts is its only importer.
import type { DataSource } from "@/data/ports";
import { agents } from "./agents";
import { approvals } from "./approvals";
import { billing } from "./billing";
import { org } from "./org";
import { pretenant } from "./pretenant";
import { runs } from "./runs";
import { shell } from "./shell";
import { skills } from "./skills";
import { spend } from "./spend";

export const liveSource: DataSource = {
  pretenant,
  shell,
  runs,
  approvals,
  agents,
  billing,
  org,
  spend,
  skills,
};
