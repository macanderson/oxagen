import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  orgModelCredentialVerify,
  orgModelCredentialVerifyInputObject,
} from "@oxagen/oxagen/contracts/org.model_credential.verify";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Derived from the contract's base object (the refined `input` has no `.shape`).
// invoke() re-parses the full refined contract input, so the rule that
// provider and apiKey travel together is still enforced when the tool is
// called.
export const schema = {
  ...orgModelCredentialVerifyInputObject.shape,
  provider: orgModelCredentialVerifyInputObject.shape.provider.describe(
    "Which vendor issued the candidate key: 'openrouter' or 'gateway' (Vercel AI Gateway). Give it together with apiKey, or omit both to verify the key already stored for the organisation",
  ),
  apiKey: orgModelCredentialVerifyInputObject.shape.apiKey.describe(
    "A candidate key to check before storing it, 8 to 512 characters. Give it together with provider, or omit both to verify the stored key. Never stored by this tool",
  ),
};

export const metadata: ToolMetadata = {
  name: orgModelCredentialVerify.name,
  description: orgModelCredentialVerify.description,
  annotations: {
    // A metadata read against the vendor's key endpoint that spends no
    // tokens. The one write is a verification timestamp on the stored
    // credential when it passes, which changes no state a caller relies on.
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
  return orgModelCredentialVerify.output.parse(output);
}
