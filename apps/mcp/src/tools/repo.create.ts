import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoCreate } from "@oxagen/oxagen/contracts/repo.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoCreate.input.shape,
  org: repoCreate.input.shape.org.describe(
    "GitHub organisation slug to create the repository in. Omit to create the repository in the connected user's personal account.",
  ),
  name: repoCreate.input.shape.name.describe("Repository name"),
  description: repoCreate.input.shape.description.describe(
    "Short repository description",
  ),
  private: repoCreate.input.shape.private.describe(
    "Whether the repository is private (default: false)",
  ),
  autoInit: repoCreate.input.shape.autoInit.describe(
    "Initialise the repository with a README (default: false)",
  ),
};

export const metadata: ToolMetadata = {
  name: repoCreate.name,
  description:
    "Creates a new GitHub repository in the connected user's account or an organisation. Prefer over fork_repo when a fresh, empty repository is needed rather than a copy of an existing one. Do not use to copy an existing repo's history — use fork_repo instead.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function repoCreateTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoCreate.name, args, ctx, { surface: "mcp" });
  return repoCreate.output.parse(output);
}
