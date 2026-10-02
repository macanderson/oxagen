/**
 * `set_assistant_switch`: Oxagen's own switch on its in-app assistant, for one
 * workspace.
 *
 * Customers never configure governance against the assistant (maintainer
 * ruling, 2026-10-01), so `set_kill_switch` refuses the workspace's managed
 * `qa-chat` agent as a target. Oxagen keeps one operator switch. This is it.
 * Turning it on writes the same `agent` kill switch row `set_kill_switch` used
 * to write: a `resource_scope` deny in `iam.emergency_denies` over
 * `resourceScopeDigestOf({ kind: "agent", id: <qa-chat public id> })`, under
 * the workspace. `readAssistantAgentState` (packages/agent/src/runtime/
 * assistant-run.ts) matches that digest and refuses the next turn with
 * `AssistantStoppedError`. Turning it off clears the row.
 *
 * Three declarations keep it off every customer path, as on
 * `set_org_billing_terms`:
 *
 *   - `platformOnly: true`: the kernel refuses the invocation before the IAM
 *     check unless the context carries a binding minted by the
 *     platform-operator factory (INV-31).
 *   - `surfaces: []`: no API route, no MCP tool, no CLI command, no app
 *     binding. `layers` lists only what exists.
 *   - `defaultEffect: "deny"` with `defaultRoles: {}`: no role in any
 *     organisation grants it.
 *
 * `scoped: false`: the call carries no tenant, because a platform operator is
 * not a member of the organisation it acts on. The input names the
 * organisation and the workspace, and the handler enters that workspace's
 * tenant scope itself.
 *
 * The one caller is `tools/scripts/assistant-switch.ts`
 * (`pnpm assistant:switch --org <slug> --workspace <slug> --on|--off
 * --reason <text>`).
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const assistantSwitchSet = registerCapability({
  name: "set_assistant_switch",
  domain: "assistant",
  description:
    "Platform-operator only: stop or restart Oxagen's in-app assistant in one workspace. On writes an agent kill switch on the workspace's managed assistant agent, which refuses every later turn. Off clears it. The reason is recorded on the switch.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "unit", "docs"],
  scoped: false,
  platformOnly: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: {}, workspace: {} },
  input: z
    .object({
      orgId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      /** True stops the assistant. False lets it answer again. */
      on: z.boolean(),
      /**
       * Why. Stored on the switch row: as `reason` when turning it on, as
       * `cleared_reason` when turning it off. Not stored when nothing changes.
       */
      reason: z.string().trim().min(1).max(500),
    })
    .strict(),
  output: z
    .object({
      /**
       * `emd_…` of the switch row this call wrote, cleared, or found already
       * on. Null when the call turned the switch off and none was on.
       */
      switchId: z.string().nullable(),
      /** False when the switch was already in the requested state. */
      changed: z.boolean(),
    })
    .strict(),
});

export type AssistantSwitchSetInput = z.output<typeof assistantSwitchSet.input>;
export type AssistantSwitchSetOutput = z.output<
  typeof assistantSwitchSet.output
>;
