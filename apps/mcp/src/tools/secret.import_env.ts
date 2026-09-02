import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { secretImportEnv } from "@oxagen/oxagen/contracts/secret.import_env";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...secretImportEnv.input.shape,
};

export const metadata: ToolMetadata = {
  name: secretImportEnv.name,
  description: secretImportEnv.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function secretImportEnvTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(secretImportEnv.name, args, ctx, {
    surface: "mcp",
  });
  return secretImportEnv.output.parse(output);
}
