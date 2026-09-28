// input.ts: a root field's arguments as inputSchema (mcp-studio-spec, Mapping:
// GraphQL).
//
// Non-null with no default is required, an enum is a string enum, and an input
// object is inlined. A nullable argument does not accept null: leaving it out
// sends the same thing. An input object nested more than 4 deep, or past the
// 500th property, is cut to { "type": "object" } with a note.
import {
  isInputObjectType,
  isListType,
  isNonNullType,
  type GraphQLArgument,
  type GraphQLInputField,
  type GraphQLInputObjectType,
  type GraphQLInputType,
} from "graphql";
import { leafSchema, withDescription, type JsonSchema, type ObjectSchema } from "./json-schema";
import type { Notes } from "./notes";

const INPUT_DEPTH_MAX = 4;
const INPUT_PROPERTIES_MAX = 500;

type InputMember = GraphQLArgument | GraphQLInputField;

interface InputContext {
  tool: string;
  notes: Notes;
  /** The input objects open above the current member. */
  depth: number;
  /** The input object properties left before objects are cut. */
  budget: number;
}

/** The field's arguments as one object schema. */
export function inputSchemaOf(args: readonly GraphQLArgument[], tool: string, notes: Notes): ObjectSchema {
  return objectOf(args, { tool, notes, depth: 0, budget: INPUT_PROPERTIES_MAX });
}

function objectOf(members: readonly InputMember[], context: InputContext): ObjectSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const member of members) {
    properties[member.name] = memberSchema(member, context);
    if (isNonNullType(member.type) && member.defaultValue === undefined) required.push(member.name);
  }
  return required.length === 0 ? { type: "object", properties } : { type: "object", properties, required };
}

function memberSchema(member: InputMember, context: InputContext): JsonSchema {
  const schema = withDescription(typeSchema(member.type, context), member.description);
  // valueFromAST builds an input object default with no prototype. A JSON
  // round trip makes it a plain value.
  if (member.defaultValue !== undefined) schema.default = JSON.parse(JSON.stringify(member.defaultValue)) as unknown;
  if (member.deprecationReason != null) schema.deprecated = true;
  return schema;
}

function typeSchema(type: GraphQLInputType, context: InputContext): JsonSchema {
  if (isNonNullType(type)) return typeSchema(type.ofType, context);
  if (isListType(type)) return { type: "array", items: typeSchema(type.ofType, context) };
  if (isInputObjectType(type)) return inputObject(type, context);
  return leafSchema(type);
}

function inputObject(type: GraphQLInputObjectType, context: InputContext): JsonSchema {
  if (context.depth >= INPUT_DEPTH_MAX) {
    context.notes.add(
      context.tool,
      `The input ${type.name} is nested more than ${INPUT_DEPTH_MAX} input objects deep, so its schema is cut to { "type": "object" }.`,
    );
    return { type: "object" };
  }
  if (context.budget <= 0) {
    context.notes.add(
      context.tool,
      `The input schema reached ${INPUT_PROPERTIES_MAX} properties, so ${type.name} is cut to { "type": "object" }.`,
    );
    return { type: "object" };
  }
  const fields = Object.values(type.getFields());
  context.budget -= fields.length;
  context.depth += 1;
  const schema = objectOf(fields, context);
  context.depth -= 1;
  return schema;
}
