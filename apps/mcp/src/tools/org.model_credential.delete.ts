import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgModelCredentialDelete } from "@oxagen/oxagen/contracts/org.model_credential.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// The contract takes no input: the credential is the caller's organisation's.
export const schema = {
  ...orgModelCredentialDelete.input.shape,
};

export const metadata: ToolMetadata = {
  name: orgModelCredentialDelete.name,
  description: orgModelCredentialDelete.description,
  annotations: {
    readOnlyHint: false,
    // Removing the key moves every later assistant turn onto the platform key,
    // where its tokens are billed; the stored credential is gone for good.
    destructiveHint: true,
    // Deleting when nothing is stored is not an error: the state asked for is
    // the state the caller has.
    idempotentHint: true,
  },
};

export default async function orgModelCredentialDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgModelCredentialDelete.name, args, ctx, {
    surface: "mcp",
  });
  return orgModelCredentialDelete.output.parse(output);
}
