import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  orgModelCredentialVerify,
  orgModelCredentialVerifyInputObject,
} from "@oxagen/oxagen/contracts/org.model_credential.verify";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

// Derived from the contract's base object (the refined `input` has no `.shape`).
// invoke() re-parses the full refined contract input, so the rule that
// provider and apiKey travel together is still enforced when the tool is
// called.
export const schema = {
  ...orgModelCredentialVerifyInputObject.shape,
  provider: orgModelCredentialVerifyInputObject.shape.provider.describe(
    "Which vendor issued the candidate key: 'openrouter', 'gateway' (Vercel AI Gateway), 'openai', 'anthropic', or 'openai_compatible' (any other OpenAI-compatible server, given by baseUrl). Give it together with apiKey, or omit both to verify the key already stored for the organisation",
  ),
  apiKey: orgModelCredentialVerifyInputObject.shape.apiKey.describe(
    "A candidate key to check before storing it, 8 to 512 characters. Give it together with provider, or omit both to verify the stored key. Never stored by this tool",
  ),
  baseUrl: orgModelCredentialVerifyInputObject.shape.baseUrl.describe(
    "The candidate endpoint, for provider 'openai_compatible' only. Must be https and publicly routable; checked before any request is made",
  ),
  toolProbeModel:
    orgModelCredentialVerifyInputObject.shape.toolProbeModel.describe(
      "The model the organisation will use for the balanced tier, for a caller that names only that one. Ignored when modelMap is given",
    ),
  modelMap: orgModelCredentialVerifyInputObject.shape.modelMap.describe(
    "For 'openai', 'anthropic' and 'openai_compatible': the model each tier (fast, balanced, precise) maps to, as set_model_credential would store it. Each mapped model is asked for one forced tool call, because the assistant runs on every tier",
  ),
};

export const metadata: ToolMetadata = {
  name: orgModelCredentialVerify.name,
  description: orgModelCredentialVerify.description,
  annotations: {
    // A metadata read against the vendor's key endpoint, plus one forced
    // tool call per mapped model on a direct vendor and one JSON-schema
    // answer from an OpenAI-compatible endpoint. The writes are the stored
    // credential's verification timestamp and structured-output answer,
    // which change no state a caller relies on.
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgModelCredentialVerifyTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgModelCredentialVerify.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(orgModelCredentialVerify.output.parse(output));
}
