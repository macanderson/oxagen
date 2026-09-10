import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgModelCredentialGet } from "@oxagen/oxagen/contracts/org.model_credential.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// The contract takes no input: the credential is the caller's organisation's.
export const schema = {
  ...orgModelCredentialGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: orgModelCredentialGet.name,
  description: orgModelCredentialGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgModelCredentialGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgModelCredentialGet.name, args, ctx, {
    surface: "mcp",
  });
  return orgModelCredentialGet.output.parse(output);
}
