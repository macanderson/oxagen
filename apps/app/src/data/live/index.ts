// The live DataSource: every port method is a kernelRead plus a typed mapper
// (ARCHITECTURE.md §3.3). src/data/source.ts is its only importer.
import type { DataSource } from "@/data/ports";
import { readOk } from "@/data/read";
import { agents } from "./agents";
import { approvals } from "./approvals";
import { audit } from "./audit";
import { billing } from "./billing";
import { conversations } from "./conversations";
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
  // Placeholder until the interjections lane adds ./interjections over
  // list_interjections (#3839). No page calls it yet, and nothing records an
  // interjection yet, so the queue is empty.
  interjections: {
    open: () => Promise.resolve(readOk({ items: [], more: false })),
  },
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
