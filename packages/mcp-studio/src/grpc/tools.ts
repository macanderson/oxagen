// tools.ts: a descriptor set's methods as UpstreamTool values (mcp-studio-spec,
// Mapping (gRPC)).
//
// Each unary and server-streaming method becomes one tool, named from the
// method in snake case. A server-streaming result is { items, truncated },
// the shape the gRPC Sender returns. A client-streaming or bidirectional
// method needs more than one request message, which one tool call cannot
// send, so it is listed and never becomes a tool.
//
// A tool carries no MCP annotations. The method's idempotency_level rides in
// the request template, where the Sender reads it to decide retries.
import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import type { Notes } from "../graphql/notes";
import type { ListedEntry } from "../model/import-result";
import { cutDescription, type GrpcIdempotencyLevel, type UpstreamTool } from "../model/upstream-tool";
import { SchemaBuilder, type ObjectSchema } from "./json-schema";
import { toolKeyFor } from "./names";
import type { ProtoSet } from "./set";

const LEVEL_NAMES: Record<MethodOptions_IdempotencyLevel, GrpcIdempotencyLevel> = {
  [MethodOptions_IdempotencyLevel.IDEMPOTENCY_UNKNOWN]: "IDEMPOTENCY_UNKNOWN",
  [MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS]: "NO_SIDE_EFFECTS",
  [MethodOptions_IdempotencyLevel.IDEMPOTENT]: "IDEMPOTENT",
};

export interface SetTools {
  tools: UpstreamTool[];
  listed: ListedEntry[];
}

/** One tool per unary and server-streaming method, in file, service, and method order. */
export function toolsOf(set: ProtoSet, notes: Notes): SetTools {
  const schemas = new SchemaBuilder(set.comments, notes);
  const taken = new Set<string>();
  const tools: UpstreamTool[] = [];
  const listed: ListedEntry[] = [];
  const services = set.files.flatMap((file) => set.registry.getFile(file.name)?.services ?? []);
  for (const service of services) {
    for (const method of service.methods) {
      const path = `${service.typeName}/${method.name}`;
      if (method.methodKind === "client_streaming") {
        listed.push({
          name: path,
          kind: "client_stream",
          reason: "A client-streaming method takes a stream of requests, and one tool call sends one, so it never becomes a tool.",
        });
      } else if (method.methodKind === "bidi_streaming") {
        listed.push({
          name: path,
          kind: "bidi_stream",
          reason: "A bidirectional method streams both ways, and one tool call sends one request, so it never becomes a tool.",
        });
      } else {
        const tool = toolOf(service, method, path, { schemas, taken, notes, comments: set.comments });
        if (tool !== undefined) tools.push(tool);
      }
    }
  }
  if (services.length === 0) {
    notes.add(undefined, "The files declare no service, so import made no tools. Import the files that declare the services.");
  }
  return { tools, listed };
}

interface Context {
  schemas: SchemaBuilder;
  taken: Set<string>;
  notes: Notes;
  comments: ReadonlyMap<string, string>;
}

function toolOf(service: DescService, method: DescMethod, path: string, context: Context): UpstreamTool | undefined {
  const { schemas, notes } = context;
  const input = method.input;
  const unary = method.methodKind === "unary";
  // The key is taken before the schemas are built, so their notes name the tool.
  const name = toolKeyFor(path, method.name, context.taken, notes);
  schemas.beginTool(name);
  const inputSchema = schemas.objectSchema(input, "input");
  if (inputSchema === undefined) {
    context.taken.delete(name);
    notes.add(
      undefined,
      `${path} takes ${input.typeName}, whose JSON form is not an object, and a tool's arguments are one object. Import made no tool for it.`,
    );
    return undefined;
  }
  const outputSchema = unary ? schemas.objectSchema(method.output, "output") : streamSchema(method, schemas);
  if (unary && outputSchema === undefined) {
    notes.add(
      name,
      `${path} returns ${method.output.typeName}, whose JSON form is not an object, so the tool has no outputSchema.`,
    );
  }
  if (method.deprecated) notes.add(name, `${path} is deprecated.`);
  const description = context.comments.get(`${service.typeName}.${method.name}`);
  return {
    name,
    ...(description === undefined ? {} : { description: cutDescription(description) }),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(method.deprecated ? { deprecated: true } : {}),
    request: {
      kind: "grpc",
      method: path,
      streaming: unary ? "unary" : "server",
      idempotency_level: LEVEL_NAMES[method.idempotency],
      request_type: input.typeName,
      response_type: method.output.typeName,
    },
  };
}

/** A server stream's result: the messages read, and whether the Sender stopped before the stream ended. */
function streamSchema(method: DescMethod, schemas: SchemaBuilder): ObjectSchema {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "The messages the stream sent, in order.",
        items: schemas.messageSchema(method.output, "output", 0),
      },
      truncated: {
        type: "boolean",
        description: "True when the call stopped at max_items, the size cap, or the deadline before the stream ended.",
      },
    },
    required: ["items", "truncated"],
  };
}
