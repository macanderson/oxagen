// Typed shell view-model values for the shell's unit and component tests
// (ARCHITECTURE.md §5): one organization with two workspaces, a viewer who
// belongs to the first, and the context read in its `ok` state. Tests override
// the read they exercise. Importable from tests only: `testOnlyTarget` in
// src/test/arch/layers.ts refuses every production edge to a `*.builders` module.
import type { ShellContext } from "@/data/contracts/shell";
import { readOk } from "@/data/not-backed";
import type { ShellData } from "./shell-data";

export const SHELL_VIEWER = {
  id: "usr_marcusbell",
  name: "Marcus Bell",
  email: "marcus.bell@acme.example",
} as const;

export const SHELL_ORG_ID = "7a000000-0000-4000-8000-0000000000a1";

const context: ShellContext = {
  viewer: SHELL_VIEWER,
  org: {
    slug: "acme",
    name: "Acme Robotics",
    plan: "Scale",
    dataPlane: "shared",
    region: "us-east-1",
  },
  orgs: [{ slug: "acme", name: "Acme Robotics", plan: "Scale" }],
  workspaces: [
    {
      slug: "core-platform",
      name: "Core platform",
      mainRepo: "acme/platform",
      productionBranch: "main",
      agentCount: 38,
    },
    {
      slug: "finops",
      name: "FinOps",
      mainRepo: null,
      productionBranch: null,
      agentCount: 4,
    },
  ],
};

/** The shell read in its `ok` state, with any field overridden. */
export function shellData(overrides: Partial<ShellData> = {}): ShellData {
  return { org: "acme", context: readOk(context), ...overrides };
}
