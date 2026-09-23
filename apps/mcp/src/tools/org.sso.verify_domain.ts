import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgSsoVerifyDomain } from "@oxagen/oxagen/contracts/org.sso.verify_domain";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  providerId: orgSsoVerifyDomain.input.shape.providerId.describe(
    "The id of the provider whose domain to verify. Publish the TXT record from list_sso_providers first",
  ),
};

export const metadata: ToolMetadata = {
  name: orgSsoVerifyDomain.name,
  description: orgSsoVerifyDomain.description,
  annotations: {
    readOnlyHint: false,
    // Marks the domain verified; checking again changes nothing further.
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgSsoVerifyDomainTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgSsoVerifyDomain.name, args, ctx, {
    surface: "mcp",
  });
  return orgSsoVerifyDomain.output.parse(output);
}
