import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgModelCredentialSet } from "@oxagen/oxagen/contracts/org.model_credential.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...orgModelCredentialSet.input.shape,
  provider: orgModelCredentialSet.input.shape.provider.describe(
    "Which vendor issued the key: 'openrouter' or 'gateway' (Vercel AI Gateway). An OpenRouter key serves language models only; embeddings stay on the platform key and are billed",
  ),
  apiKey: orgModelCredentialSet.input.shape.apiKey.describe(
    "The vendor API key, 8 to 512 characters. Envelope-encrypted at rest and never readable back; only its last four characters are ever returned",
  ),
};

export const metadata: ToolMetadata = {
  name: orgModelCredentialSet.name,
  description: orgModelCredentialSet.description,
  annotations: {
    readOnlyHint: false,
    // An organisation holds one credential; storing a key replaces the one
    // already there, so this is destructive in the MCP sense.
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function orgModelCredentialSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgModelCredentialSet.name, args, ctx, {
    surface: "mcp",
  });
  return orgModelCredentialSet.output.parse(output);
}
