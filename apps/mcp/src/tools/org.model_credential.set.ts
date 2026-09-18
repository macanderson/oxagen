import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  orgModelCredentialSet,
  orgModelCredentialSetInputObject,
} from "@oxagen/oxagen/contracts/org.model_credential.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Built from the BASE object: the registered input is refined (superRefine)
// and has no `.shape`. `invoke()` re-parses the refined input, so the
// cross-field rules — base URL exactly for openai_compatible, a balanced
// model for a direct-vendor key, no internal endpoints — still hold here.
const shape = orgModelCredentialSetInputObject.shape;

export const schema = {
  ...shape,
  provider: shape.provider.describe(
    "Which vendor issued the key. 'openrouter' or 'gateway' (Vercel AI Gateway) reach every model through one key and need nothing else. 'openai' or 'anthropic' are a direct vendor key and need modelMap.balanced. 'openai_compatible' is any other OpenAI-compatible server and needs baseUrl and modelMap.balanced",
  ),
  apiKey: shape.apiKey.describe(
    "The vendor API key, 8 to 512 characters. Envelope-encrypted at rest and never readable back; only its last four characters are ever returned",
  ),
  baseUrl: shape.baseUrl.describe(
    "The endpoint, for provider 'openai_compatible' only — e.g. https://api.together.xyz/v1. Must be https and publicly routable. Omit for every other provider",
  ),
  modelMap: shape.modelMap.describe(
    "The model id this key uses for each tier: { fast?, balanced?, precise? }. Required (balanced at least) for 'openai', 'anthropic' and 'openai_compatible', whose model names differ from Oxagen's. Unmapped tiers use the balanced model. Ignored for 'openrouter' and 'gateway'",
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
