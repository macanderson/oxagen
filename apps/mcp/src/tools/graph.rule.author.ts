import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphRuleAuthor } from "@oxagen/oxagen/contracts/graph.rule.author";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphRuleAuthor.input.shape,
  rule: graphRuleAuthor.input.shape.rule.describe(
    "The rule: relationshipType (e.g. OWNS_ACCOUNT), and at each end the node label and the source that contributes it (start: Person from hubspot, end: Account from stripe). The two sources differ.",
  ),
  note: graphRuleAuthor.input.shape.note.describe(
    "Context the rule does not carry, such as the property both ends share. It never changes the goal.",
  ),
};

export const metadata: ToolMetadata = {
  name: graphRuleAuthor.name,
  description: graphRuleAuthor.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function authorGraphRuleTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphRuleAuthor.name, args, ctx, {
    surface: "mcp",
  });
  return graphRuleAuthor.output.parse(output);
}
