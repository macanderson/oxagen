// Typed shell values for the shell's unit and component tests (ARCHITECTURE.md
// §5): one organization, the viewer the layout resolved, and its shell.context
// read. Importable from tests only: `testOnlyTarget` in src/test/arch/layers.ts
// refuses every production edge to a `*.builders` module.
import { readOk } from "@/data/read";
import type { ShellData } from "./shell-data";

const SHELL_VIEWER = {
  name: "Marcus Bell",
  email: "marcus.bell@acme.example",
  avatarUrl: null,
  id: "usr_01K3F8QB7R",
  orgRole: "member",
  emailVerified: true,
  twoFactorEnabled: true,
  timeZone: "America/Los_Angeles",
} as const;

const SHELL_ORG = {
  key: "org_acme",
  slug: "acme",
  name: "Acme Robotics",
} as const;

const SHELL_CONTEXT = readOk({
  orgs: [SHELL_ORG],
  workspaces: [{ slug: "core-platform", name: "Core platform" }],
});

/** The shell data the layout's viewer yields, with any field overridden. */
export function shellData(overrides: Partial<ShellData> = {}): ShellData {
  return {
    org: SHELL_ORG,
    viewer: SHELL_VIEWER,
    context: SHELL_CONTEXT,
    fleetWaiting: null,
    ...overrides,
  };
}
