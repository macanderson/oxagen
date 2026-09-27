// descriptors.ts: encode and decode gRPC messages from a FileDescriptorSet,
// with no generated code (mcp-studio-spec, Mapping (gRPC)).
//
// The library is @bufbuild/protobuf. Its toJson and fromJson implement the
// canonical proto3 JSON mapping: 64-bit integers as strings, enums by name,
// the JSON forms of the well-known types, and google.protobuf.Any through a
// registry. The mapping passes the protobuf conformance suite, and the
// library reads a descriptor set at run time. Buf maintains it, and it has
// no dependencies. protobufjs, the other option in the tree, has its own
// JSON form that differs from the canonical mapping.
import {
  createFileRegistry,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type DescMessage,
  type FileRegistry,
  type JsonObject,
  type JsonValue,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema, MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import type { GrpcIdempotencyLevel, GrpcRequest } from "../../model/upstream-tool";

/** One method, resolved from the descriptors. */
export interface ResolvedMethod {
  registry: FileRegistry;
  input: DescMessage;
  output: DescMessage;
  /** The method's idempotency_level option, from the descriptor set. The Sender retries by this level. */
  idempotency_level: GrpcIdempotencyLevel;
}

const LEVEL_NAMES: Record<MethodOptions_IdempotencyLevel, GrpcIdempotencyLevel> = {
  [MethodOptions_IdempotencyLevel.IDEMPOTENCY_UNKNOWN]: "IDEMPOTENCY_UNKNOWN",
  [MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS]: "NO_SIDE_EFFECTS",
  [MethodOptions_IdempotencyLevel.IDEMPOTENT]: "IDEMPOTENT",
};

/** Why a method did not resolve, or a message did not encode or decode. */
export class DescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DescriptorError";
  }
}

// A manifest carries its descriptor set as base64, and one server's calls
// reuse it, so the parsed registry is kept by that string. The cap bounds
// memory when many servers call through one process.
const REGISTRY_CACHE_SIZE = 32;
const registries = new Map<string, FileRegistry>();

function registryFor(descriptorSet: string): FileRegistry {
  const cached = registries.get(descriptorSet);
  if (cached !== undefined) return cached;
  let registry: FileRegistry;
  try {
    const bytes = Buffer.from(descriptorSet, "base64");
    registry = createFileRegistry(fromBinary(FileDescriptorSetSchema, bytes));
  } catch (error) {
    throw new DescriptorError(`The server's descriptor_set does not parse: ${messageOf(error)}`);
  }
  if (registries.size >= REGISTRY_CACHE_SIZE) {
    const oldest = registries.keys().next();
    if (oldest.done !== true) registries.delete(oldest.value);
  }
  registries.set(descriptorSet, registry);
  return registry;
}

/**
 * Find the template's method in the descriptor set, and check that its
 * streaming kind, message types, and idempotency level match the template.
 * A tool that marks an unsafe method safe would let the Sender retry it, so
 * a level that differs from the descriptor is refused.
 */
export function resolveMethod(descriptorSet: string | undefined, template: GrpcRequest): ResolvedMethod {
  if (descriptorSet === undefined) {
    throw new DescriptorError("The server has no descriptor_set. Import the server's protos again.");
  }
  const registry = registryFor(descriptorSet);
  const slash = template.method.lastIndexOf("/");
  const serviceName = template.method.slice(0, slash);
  const methodName = template.method.slice(slash + 1);
  const service = registry.getService(serviceName);
  if (service === undefined) {
    throw new DescriptorError(`The descriptor set has no service ${serviceName}.`);
  }
  const method = service.methods.find((candidate) => candidate.name === methodName);
  if (method === undefined) {
    throw new DescriptorError(`The service ${serviceName} has no method ${methodName}.`);
  }
  const expected = template.streaming === "unary" ? "unary" : "server_streaming";
  if (method.methodKind !== expected) {
    throw new DescriptorError(
      `${template.method} is ${method.methodKind} in the descriptor set, but the tool calls it as ${expected}.`,
    );
  }
  if (method.input.typeName !== template.request_type || method.output.typeName !== template.response_type) {
    throw new DescriptorError(
      `${template.method} takes ${method.input.typeName} and returns ${method.output.typeName}, ` +
        `but the tool names ${template.request_type} and ${template.response_type}.`,
    );
  }
  const level = LEVEL_NAMES[method.idempotency];
  if (level !== template.idempotency_level) {
    throw new DescriptorError(
      `${template.method} is ${level} in the descriptor set, but the tool marks it ${template.idempotency_level}.`,
    );
  }
  return { registry, input: method.input, output: method.output, idempotency_level: level };
}

/** Encode the upstream arguments as the request message. Unknown fields are refused. */
export function encodeRequest(method: ResolvedMethod, args: JsonObject): Uint8Array {
  try {
    return toBinary(method.input, fromJson(method.input, args, { registry: method.registry }));
  } catch (error) {
    throw new DescriptorError(`The arguments do not encode as ${method.input.typeName}: ${messageOf(error)}`);
  }
}

/**
 * Decode one response message to JSON.
 *
 * Fields that hold their default value are written too (alwaysEmitImplicit),
 * which the proto3 JSON mapping allows. A tool's outputSchema can then list
 * every field as required, and the result still matches it.
 */
export function decodeResponse(method: ResolvedMethod, bytes: Uint8Array): JsonValue {
  try {
    return toJson(method.output, fromBinary(method.output, bytes), {
      registry: method.registry,
      alwaysEmitImplicit: true,
    });
  } catch (error) {
    throw new DescriptorError(`The response does not decode as ${method.output.typeName}: ${messageOf(error)}`);
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
