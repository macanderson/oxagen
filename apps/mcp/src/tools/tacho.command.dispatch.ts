import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  dispatchCommandFieldsSchema,
  tachoCommandDispatch,
} from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...dispatchCommandFieldsSchema.shape,
  target: dispatchCommandFieldsSchema.shape.target.describe(
    "One run (kind run, an arun_… or tse_… id), every live run of an agent (kind agent, the agent key as list_runs reports it; a steer or message to an agent with no live run waits for its next run), or every live run in the workspace (kind workspace, the workspace id)",
  ),
  command: dispatchCommandFieldsSchema.shape.command.describe(
    "pause, resume, cancel, steer or message",
  ),
  payload: dispatchCommandFieldsSchema.shape.payload.describe(
    "Required for steer and message: the text, and the requested delivery mode (next_step, interrupt, turn_boundary; a ceiling on a broadcast)",
  ),
  reason: dispatchCommandFieldsSchema.shape.reason.describe(
    "Read by the model on resume and shown on the pause banner",
  ),
  expiresInMs: dispatchCommandFieldsSchema.shape.expiresInMs.describe(
    "10 000 to 86 400 000 ms; default one hour",
  ),
};

export const metadata: ToolMetadata = {
  name: tachoCommandDispatch.name,
  description: tachoCommandDispatch.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function dispatchCommandTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const input = tachoCommandDispatch.input.parse(args);
  const output = await invoke(tachoCommandDispatch.name, input, ctx, {
    surface: "mcp",
  });
  return tachoCommandDispatch.output.parse(output);
}
