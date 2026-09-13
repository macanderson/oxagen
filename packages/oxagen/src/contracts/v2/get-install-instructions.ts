import { z } from "zod";
import { defineTool } from "./_define";
import { systemInstallInstructions } from "../system.install.instructions";

/**
 * Appendix E: `get_install_instructions` — "per harness". Absorbs
 * `get_install_instructions`. One source, clean 1:1 carry, `drops` is `[]`.
 *
 * **The one change is a rename, not a drop.** v1 calls the argument `client`.
 * §3 fixes the word for the thing an agent runs inside as *harness*, and §7.2
 * ("Adapters and supported agents") is written entirely in those terms, so the
 * key becomes `harness` on both the input and the output. The enum itself is
 * carried by reference — the five values are the harnesses an adapter exists
 * for, and widening that set is a change to §7.2's adapter list, not to this
 * contract.
 *
 * **Why the render directive stays.** It is the one output field that only one
 * surface can act on, and §14.1 says a single contract drives all four. It is
 * carried anyway: the in-app agent is on every screen (§4.4), install
 * instructions are the archetypal thing it answers with, and an API or CLI
 * caller reading past a field it does not need costs nothing — whereas moving
 * the component binding out of the contract would mean the agent surface
 * returning prose that the app then has to pattern-match back into a component.
 */
export const getInstallInstructions = defineTool({
  name: "get_install_instructions",
  domain: "assistant",
  description:
    "Return step-by-step installation instructions for connecting a harness (Claude Code, Cursor, Claude Desktop, Codex, VS Code) to this workspace, with copyable commands and config snippets.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  /**
   * New in v2. Rendering install instructions is string templating over
   * `APP_URL` / `MCP_URL` and consumes no model tokens, and this is the tool a
   * customer reaches for when they are setting up — refusing it because the
   * balance is zero blocks the path to them ever paying.
   */
  noBillingGate: true,

  absorbs: ["get_install_instructions"],
  renames: [
    {
      from: "client",
      source: "get_install_instructions",
      to: "harness",
      why: "§3 fixes *harness* as the word for the thing an agent runs inside, and §7.2 (\"Adapters and supported agents\") is written entirely in those terms. The enum is carried by reference, so nothing but the key changes — and the output key changes with it, because a request and its echo must not disagree about what the thing is called.",
    },
  ],
  drops: [],

  // Carried unchanged. Low and non-approval: the output is public-shaped
  // configuration text, and the only workspace-specific value in it is the
  // slug the caller already had to hold to make the call.
  agent: { requiresApproval: false, riskLevel: "low", category: "system" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * Read-only, confirmed against
   * `packages/handlers/src/system.install.instructions.ts`: it templates from
   * environment configuration and touches no store.
   */
  mutates: false,

  input: z.object({
    /** Carried from `client` under §3's vocabulary. See the note above. */
    harness: systemInstallInstructions.input.shape.client,
    /**
     * Personalises the config snippets. Optional: the instructions are usable
     * with placeholders, and a caller who has not chosen a workspace yet is the
     * common case for this particular tool.
     */
    workspaceSlug: systemInstallInstructions.input.shape.workspaceSlug,
  }),

  output: z.object({
    harness: systemInstallInstructions.output.shape.client,
    /**
     * Ordered, at least one. Each step is a label plus an optional command or
     * config snippet to show behind a copy button — the optionality is what
     * lets a prose-only step exist without a fake command.
     */
    steps: systemInstallInstructions.output.shape.steps,
    /** The chat component binding. See the note above for why it survives. */
    render: systemInstallInstructions.output.shape.render,
  }),
});

export type GetInstallInstructionsInput = z.output<
  typeof getInstallInstructions.input
>;
export type GetInstallInstructionsOutput = z.output<
  typeof getInstallInstructions.output
>;
