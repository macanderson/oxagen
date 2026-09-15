// The live DataSource: every port method is a kernelRead plus a typed mapper
// (ARCHITECTURE.md §3.3). src/data/source.ts is its only importer.
import type { DataSource } from "@/data/ports";
import { approvals } from "./approvals";
import { billing } from "./billing";
import { pretenant } from "./pretenant";
import { runs } from "./runs";
import { shell } from "./shell";

export const liveSource: DataSource = {
  pretenant,
  shell,
  runs,
  approvals,
  billing,
};
