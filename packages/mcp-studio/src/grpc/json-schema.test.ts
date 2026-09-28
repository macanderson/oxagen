// json-schema.test.ts: a request tool's inputSchema refuses the arguments
// the encoder refuses, for an Any and for each kind of map key.
//
// executeCall checks the arguments against inputSchema (execute/validate.ts)
// before encodeRequest turns them into the request with fromJson. When the
// schema passes what fromJson refuses, the model gets an encoding error
// instead of a message about its argument. Each case below runs both checks
// and expects the same answer. The last test lists where the schema is
// deliberately stricter than the encoder.
import type { JsonObject } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { encodeRequest, resolveMethod, type ResolvedMethod } from "../execute/grpc/descriptors";
import { validateInput } from "../execute/validate";
import type { UpstreamTool } from "../model/upstream-tool";
import { importGrpc } from "./index";

const KEYED_PROTO = `syntax = "proto3";
package acme.v1;

import "google/protobuf/any.proto";

message Keys {
  map<int32, string> int32_key = 1;
  map<sint32, string> sint32_key = 2;
  map<sfixed32, string> sfixed32_key = 3;
  map<int64, string> int64_key = 4;
  map<sint64, string> sint64_key = 5;
  map<sfixed64, string> sfixed64_key = 6;
  map<uint32, string> uint32_key = 7;
  map<fixed32, string> fixed32_key = 8;
  map<uint64, string> uint64_key = 9;
  map<fixed64, string> fixed64_key = 10;
  map<bool, string> bool_key = 11;
  map<string, string> string_key = 12;
  google.protobuf.Any detail = 13;
}

service Keyed {
  rpc Put(Keys) returns (Keys);
}
`;

interface Keyed {
  tool: UpstreamTool;
  method: ResolvedMethod;
}

async function keyed(): Promise<Keyed> {
  const result = await importGrpc({ files: [{ path: "acme/keys.proto", text: KEYED_PROTO }] });
  const [tool] = result.tools;
  if (tool === undefined || tool.request.kind !== "grpc") throw new Error("The import made no gRPC tool.");
  if (result.descriptor_set === undefined) throw new Error("The import returned no descriptor_set.");
  const method = resolveMethod(Buffer.from(result.descriptor_set).toString("base64"), tool.request);
  return { tool, method };
}

/** Whether the tool's inputSchema passes the arguments. */
function schemaPasses(tool: UpstreamTool, args: JsonObject): boolean {
  return validateInput(tool.inputSchema, args).length === 0;
}

/** Whether encodeRequest turns the arguments into the request. */
function encodes(method: ResolvedMethod, args: JsonObject): boolean {
  try {
    encodeRequest(method, args);
    return true;
  } catch {
    return false;
  }
}

const SIGNED = ["int32Key", "sint32Key", "sfixed32Key", "int64Key", "sint64Key", "sfixed64Key"];
const UNSIGNED = ["uint32Key", "fixed32Key", "uint64Key", "fixed64Key"];

/** A field, a map key or Any value, and whether both checks must pass it. */
const CASES: [field: string, value: JsonObject, passes: boolean][] = [
  ...SIGNED.flatMap((field): [string, JsonObject, boolean][] => [
    [field, { "-7": "x" }, true],
    [field, { "42": "x" }, true],
    [field, { "not-an-int": "x" }, false],
    [field, { "1.5": "x" }, false],
  ]),
  ...UNSIGNED.flatMap((field): [string, JsonObject, boolean][] => [
    [field, { "7": "x" }, true],
    [field, { "-7": "x" }, false],
    [field, { "not-an-int": "x" }, false],
  ]),
  ["boolKey", { true: "x", false: "y" }, true],
  ["boolKey", { yes: "x" }, false],
  ["boolKey", { "1": "x" }, false],
  ["stringKey", { "not-an-int": "x" }, true],
  ["detail", { "@type": "type.googleapis.com/acme.v1.Keys" }, true],
  ["detail", { "@type": "acme.v1.Keys" }, true],
  ["detail", { "@type": "" }, false],
  ["detail", { "@type": "type.googleapis.com/" }, false],
  ["detail", { value: "x" }, false],
];

describe("a request's inputSchema", () => {
  it.each(CASES)("%s %j: the schema and the encoder agree", async (field, value, passes) => {
    const { tool, method } = await keyed();
    const args = { [field]: value };
    expect({ schema: schemaPasses(tool, args), encoder: encodes(method, args) }).toStrictEqual({
      schema: passes,
      encoder: passes,
    });
  });

  it("names the refused map key", async () => {
    const { tool } = await keyed();
    expect(validateInput(tool.inputSchema, { int32Key: { "1.5": "x" } })).toStrictEqual([
      'input.int32Key["1.5"] is not an allowed property.',
    ]);
  });

  it("names the missing @type", async () => {
    const { tool } = await keyed();
    expect(validateInput(tool.inputSchema, { detail: { value: "x" } })).toStrictEqual([
      'input.detail["@type"] is required.',
    ]);
  });

  it("is stricter than the encoder for a hex int32 key and an empty Any", async () => {
    const { tool, method } = await keyed();
    // fromJson reads an int32 key with Number(), so it also takes "0x10". toJson writes decimal.
    const hex = { int32Key: { "0x10": "x" } };
    // fromJson reads {} as an empty Any. Leaving the field out says the same.
    const empty = { detail: {} };
    expect([encodes(method, hex), encodes(method, empty)]).toStrictEqual([true, true]);
    expect([schemaPasses(tool, hex), schemaPasses(tool, empty)]).toStrictEqual([false, false]);
  });
});

describe("a response's outputSchema", () => {
  it("leaves map keys to toJson and takes an empty Any", async () => {
    const { tool } = await keyed();
    const output = tool.outputSchema as { properties: Record<string, Record<string, unknown>> };
    expect(output.properties.int32Key).toStrictEqual({ type: "object", additionalProperties: { type: "string" } });
    expect(output.properties.detail).toStrictEqual({
      type: "object",
      properties: { "@type": { type: "string" } },
      additionalProperties: true,
    });
  });
});
