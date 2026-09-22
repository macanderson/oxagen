import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { tachoSessionPolicyWrite } from "@oxagen/oxagen/contracts/tacho.session_policy.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...tachoSessionPolicyWrite.input.shape,
  mode: tachoSessionPolicyWrite.input.shape.mode.describe(
    "observed = the gateway meters every model call and refuses none; enforced = it refuses a call that breaks the session limit or the model lists. Enforced is refused unless at least one of those is set (omit to leave unchanged)",
  ),
  sessionLimitUsd: tachoSessionPolicyWrite.input.shape.sessionLimitUsd.describe(
    "Per-session ceiling in USD, e.g. 25.00. Checked when a call is admitted, so a session can end one call past its limit (null clears it; omit to leave unchanged)",
  ),
  modelAllow: tachoSessionPolicyWrite.input.shape.modelAllow.describe(
    'The only models a wrapped harness may call, e.g. ["claude-opus-*", "gpt-5"]. A trailing * matches by prefix. null drops the allowlist and permits every model; [] permits none (omit to leave unchanged)',
  ),
  modelDeny: tachoSessionPolicyWrite.input.shape.modelDeny.describe(
    "Models refused whatever the allowlist says; a deny beats an allow. [] refuses none (omit to leave unchanged)",
  ),
};

export const metadata: ToolMetadata = {
  name: tachoSessionPolicyWrite.name,
  description: tachoSessionPolicyWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function tachoSessionPolicyWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(tachoSessionPolicyWrite.name, args, ctx, {
    surface: "mcp",
  });
  return tachoSessionPolicyWrite.output.parse(output);
}
