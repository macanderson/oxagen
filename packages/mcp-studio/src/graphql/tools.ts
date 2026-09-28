// tools.ts: a schema's root fields as UpstreamTool values (mcp-studio-spec,
// Mapping: GraphQL).
//
// Each Query and Mutation field becomes one tool, named from the field in
// snake case. A Subscription field streams events, so it is listed and never
// becomes a tool.
import { isNonNullType, type GraphQLArgument, type GraphQLObjectType, type GraphQLSchema } from "graphql";
import type { ImportNote, ListedEntry } from "../model/import-result";
import { cutDescription, type GraphqlArgument, type UpstreamTool } from "../model/upstream-tool";
import { inputSchemaOf } from "./input";
import { toolKeyFor } from "./names";
import { Notes } from "./notes";
import { resultOf } from "./selection";

export interface SchemaTools {
  tools: UpstreamTool[];
  listed: ListedEntry[];
  notes: ImportNote[];
}

/** One tool per Query field, then one per Mutation field, in the schema's order. */
export function toolsOf(schema: GraphQLSchema): SchemaTools {
  const notes = new Notes();
  const taken = new Set<string>();
  const tools: UpstreamTool[] = [];
  const roots: [GraphQLObjectType | null | undefined, "query" | "mutation"][] = [
    [schema.getQueryType(), "query"],
    [schema.getMutationType(), "mutation"],
  ];
  for (const [root, operationType] of roots) {
    if (root == null) continue;
    for (const field of Object.values(root.getFields())) {
      const path = `${root.name}.${field.name}`;
      const name = toolKeyFor(path, field.name, taken, notes);
      if (field.deprecationReason != null) notes.add(name, `${path} is deprecated: ${field.deprecationReason}`);
      const inputSchema = inputSchemaOf(field.args, name, notes);
      const result = resultOf(field, path, { schema, tool: name, notes });
      tools.push({
        name,
        ...(field.description ? { description: cutDescription(field.description) } : {}),
        inputSchema,
        ...(result.outputSchema === undefined ? {} : { outputSchema: result.outputSchema }),
        ...(field.deprecationReason != null ? { deprecated: true } : {}),
        ...(result.paging === undefined ? {} : { paging: result.paging }),
        request: {
          kind: "graphql",
          operation_type: operationType,
          field: path,
          arguments: field.args.map(variableOf),
          ...(result.selection === undefined ? {} : { selection: result.selection }),
        },
      });
    }
  }

  const subscription = schema.getSubscriptionType();
  const listed: ListedEntry[] =
    subscription == null
      ? []
      : Object.values(subscription.getFields()).map((field) => ({
          name: `${subscription.name}.${field.name}`,
          kind: "subscription",
          reason: "A subscription streams events, so it never becomes a tool.",
        }));
  return { tools, listed, notes: notes.list };
}

/**
 * The argument as the operation declares its variable. A non-null argument
 * with a default is declared nullable, so a call that leaves it out sends no
 * value and the server uses the default.
 */
function variableOf(arg: GraphQLArgument): GraphqlArgument {
  const type = isNonNullType(arg.type) && arg.defaultValue !== undefined ? arg.type.ofType : arg.type;
  return { name: arg.name, type: String(type), property: arg.name };
}
