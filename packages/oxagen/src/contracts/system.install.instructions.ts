import { z } from "zod";
import { registerCapability } from "../registry";
import { enrollmentTokenSchema } from "./tacho.enrollment_token.create";

const renderDirectiveSchema = z.object({
  componentId: z.string(),
  props: z.record(z.unknown()),
});

// ── Step schema ───────────────────────────────────────────────────────────────

export const installStepSchema = z.object({
  /** Human-readable label for this step, e.g. "Add to claude_desktop_config.json". */
  label: z.string().min(1),
  /**
   * Optional shell command or config snippet to display with a copy button.
   * Omit for prose-only steps.
   */
  command: z.string().optional(),
});

// ── Supported clients ─────────────────────────────────────────────────────────

export const installClientSchema = z.enum([
  "claude-code",
  "cursor",
  "claude-desktop",
  "codex",
  "vscode",
]);

export type InstallClient = z.output<typeof installClientSchema>;

// ── Contract registration ─────────────────────────────────────────────────────

export const systemInstallInstructions = registerCapability({
  name: "get_install_instructions",
  domain: "system",
  description:
    "Return step-by-step MCP/CLI installation instructions for a given AI client " +
    "(claude-code, cursor, claude-desktop, codex, vscode). " +
    "Snippets point at the app and MCP hosts configured in APP_URL / MCP_URL. " +
    "With an enrollment token, claude-code and codex answer the wrap steps (oxagen agent enroll --token …) instead of the MCP steps. " +
    "Returns a structured steps list and a render directive for the install-instructions " +
    "chat component.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "system",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** The AI client to generate installation instructions for. */
    client: installClientSchema,
    /**
     * Optional workspace slug used to construct personalised config snippets.
     * When omitted, placeholder values are used.
     */
    workspaceSlug: z.string().optional(),
    /**
     * A token `create_enrollment_token` issued (#2967). For `claude-code` and
     * `codex` the steps become the wrap: enrol this machine with the token,
     * then start a session. Passed through, never stored.
     */
    enrollmentToken: enrollmentTokenSchema.optional(),
  }),
  output: z.object({
    /** The client these instructions target. */
    client: installClientSchema,
    /** Ordered list of installation steps. */
    steps: z.array(installStepSchema).min(1),
    /** Render directive instructing the chat UI to show install-instructions. */
    render: renderDirectiveSchema,
  }),
});

export type SystemInstallInstructionsInput = z.output<
  typeof systemInstallInstructions.input
>;
export type SystemInstallInstructionsOutput = z.output<
  typeof systemInstallInstructions.output
>;
export type InstallStep = z.output<typeof installStepSchema>;
