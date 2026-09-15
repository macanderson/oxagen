// Typed shell values for the shell's unit and component tests (ARCHITECTURE.md
// §5): one organization and the viewer the layout resolved. Importable from
// tests only: `testOnlyTarget` in src/test/arch/layers.ts refuses every
// production edge to a `*.builders` module.
import type { ShellData } from "./shell-data";

const SHELL_VIEWER = {
  name: "Marcus Bell",
  email: "marcus.bell@acme.example",
} as const;

const SHELL_ORG = { slug: "acme", name: "Acme Robotics" } as const;

/** The shell data the layout's viewer yields, with any field overridden. */
export function shellData(overrides: Partial<ShellData> = {}): ShellData {
  return { org: SHELL_ORG, viewer: SHELL_VIEWER, ...overrides };
}
