import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  toolStudioCredentialSet,
  toolStudioCredentialSetInputObject,
} from "@oxagen/oxagen/contracts/tool.studio.credential.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// The contract input is refined, so it has no `.shape`. The base object
// carries the fields, and invoke() re-parses the refined input on the call.
export const schema = {
  ...toolStudioCredentialSetInputObject.shape,
  name: toolStudioCredentialSetInputObject.shape.name.describe(
    "The credential's name. server.toml references it as oxagen:credential/<name>",
  ),
  kind: toolStudioCredentialSetInputObject.shape.kind.describe(
    "secret for a service secret, oauth_client for an OAuth client's id and secret",
  ),
  secret: toolStudioCredentialSetInputObject.shape.secret.describe(
    "The service secret. Required for kind secret, refused for oauth_client",
  ),
  clientId: toolStudioCredentialSetInputObject.shape.clientId.describe(
    "The OAuth client id. Required for kind oauth_client, refused for secret",
  ),
  clientSecret: toolStudioCredentialSetInputObject.shape.clientSecret.describe(
    "The OAuth client secret. Required for kind oauth_client, refused for secret",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioCredentialSet.name,
  description: toolStudioCredentialSet.description,
  annotations: {
    readOnlyHint: false,
    // A replace overwrites the stored value, and the old value cannot be read back.
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function toolStudioCredentialSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioCredentialSet.name, args, ctx, {
    surface: "mcp",
  });
  return toolStudioCredentialSet.output.parse(output);
}
