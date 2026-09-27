// descriptors.ts: resolve a method from the descriptor set, and encode and
// decode messages by the proto3 JSON mapping.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { create, fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { AnySchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  DescriptorError,
  decodeResponse,
  encodeRequest,
  messageOf,
  resolveMethod,
  type ResolvedMethod,
} from "./descriptors";
import { GET_ENTRY, LIST_ENTRIES, POST_ENTRY, REVERSE_ENTRY, UPLOAD_ENTRIES } from "./__tests__/ledger-context";
import { LEDGER_DESCRIPTOR_SET, LEDGER_PROTO_SHA256 } from "./__tests__/ledger-descriptor-set";

/** Encode a response message the way an upstream would. */
function entryBytes(method: ResolvedMethod, json: JsonValue): Uint8Array {
  return toBinary(method.output, fromJson(method.output, json, { registry: method.registry }));
}

describe("the ledger descriptor set", () => {
  it("was built from the current ledger.proto", () => {
    const proto = readFileSync(new URL("../../../fixtures/grpc/ledger.proto", import.meta.url));
    expect(createHash("sha256").update(proto).digest("hex")).toBe(LEDGER_PROTO_SHA256);
  });
});

describe("resolveMethod", () => {
  it("finds the method and its message types", () => {
    const method = resolveMethod(LEDGER_DESCRIPTOR_SET, GET_ENTRY);
    expect(method.input.typeName).toBe("a_intel.ledger.v1.GetEntryRequest");
    expect(method.output.typeName).toBe("a_intel.ledger.v1.Entry");
  });

  it("resolves a server stream called as one", () => {
    expect(resolveMethod(LEDGER_DESCRIPTOR_SET, LIST_ENTRIES).input.typeName).toBe(
      "a_intel.ledger.v1.ListEntriesRequest",
    );
  });

  it("refuses a server with no descriptor set", () => {
    expect(() => resolveMethod(undefined, GET_ENTRY)).toThrow(
      new DescriptorError("The server has no descriptor_set. Import the server's protos again."),
    );
  });

  it("refuses a descriptor set that does not parse", () => {
    const broken = Buffer.from([0x0a, 0xff]).toString("base64");
    expect(() => resolveMethod(broken, GET_ENTRY)).toThrow(/^The server's descriptor_set does not parse: /);
  });

  it("refuses a service the descriptor set does not have", () => {
    const template = { ...GET_ENTRY, method: "a_intel.ledger.v1.Journal/GetEntry" };
    expect(() => resolveMethod(LEDGER_DESCRIPTOR_SET, template)).toThrow(
      "The descriptor set has no service a_intel.ledger.v1.Journal.",
    );
  });

  it("refuses a method the service does not have", () => {
    const template = { ...GET_ENTRY, method: "a_intel.ledger.v1.Ledger/DeleteEntry" };
    expect(() => resolveMethod(LEDGER_DESCRIPTOR_SET, template)).toThrow(
      "The service a_intel.ledger.v1.Ledger has no method DeleteEntry.",
    );
  });

  it("refuses a server stream called as unary", () => {
    const template = { ...LIST_ENTRIES, streaming: "unary" as const };
    expect(() => resolveMethod(LEDGER_DESCRIPTOR_SET, template)).toThrow(
      "a_intel.ledger.v1.Ledger/ListEntries is server_streaming in the descriptor set, but the tool calls it as unary.",
    );
  });

  it("refuses a client stream", () => {
    expect(() => resolveMethod(LEDGER_DESCRIPTOR_SET, UPLOAD_ENTRIES)).toThrow(
      "is client_streaming in the descriptor set, but the tool calls it as unary.",
    );
  });

  it("refuses a unary method called as a server stream", () => {
    const template = { ...GET_ENTRY, streaming: "server" as const };
    expect(() => resolveMethod(LEDGER_DESCRIPTOR_SET, template)).toThrow(
      "is unary in the descriptor set, but the tool calls it as server_streaming.",
    );
  });

  it("refuses message types that differ from the template's", () => {
    const template = { ...GET_ENTRY, response_type: "a_intel.ledger.v1.UploadSummary" };
    expect(() => resolveMethod(LEDGER_DESCRIPTOR_SET, template)).toThrow(
      "a_intel.ledger.v1.Ledger/GetEntry takes a_intel.ledger.v1.GetEntryRequest and returns " +
        "a_intel.ledger.v1.Entry, but the tool names a_intel.ledger.v1.GetEntryRequest and " +
        "a_intel.ledger.v1.UploadSummary.",
    );
  });

  it.each([
    ["GetEntry", GET_ENTRY, "NO_SIDE_EFFECTS"],
    ["PostEntry", POST_ENTRY, "IDEMPOTENCY_UNKNOWN"],
    ["ReverseEntry", REVERSE_ENTRY, "IDEMPOTENT"],
    ["ListEntries", LIST_ENTRIES, "NO_SIDE_EFFECTS"],
  ] as const)("reads %s's idempotency level from the descriptor set", (_, template, level) => {
    expect(resolveMethod(LEDGER_DESCRIPTOR_SET, template).idempotency_level).toBe(level);
  });

  it("refuses an idempotency level that differs from the descriptor set's", () => {
    const template = { ...POST_ENTRY, idempotency_level: "IDEMPOTENT" as const };
    expect(() => resolveMethod(LEDGER_DESCRIPTOR_SET, template)).toThrow(
      "a_intel.ledger.v1.Ledger/PostEntry is IDEMPOTENCY_UNKNOWN in the descriptor set, " +
        "but the tool marks it IDEMPOTENT.",
    );
  });

  it("parses a descriptor set once and reuses it", () => {
    const first = resolveMethod(LEDGER_DESCRIPTOR_SET, GET_ENTRY);
    const second = resolveMethod(LEDGER_DESCRIPTOR_SET, POST_ENTRY);
    expect(second.registry).toBe(first.registry);
  });

  it("drops the oldest descriptor set after 32", () => {
    // base64 ignores whitespace, so each padded copy is a new key for the same bytes.
    const key = `${LEDGER_DESCRIPTOR_SET}\t`;
    const first = resolveMethod(key, GET_ENTRY).registry;
    for (let pad = 1; pad <= 32; pad += 1) resolveMethod(`${key}${"\n".repeat(pad)}`, GET_ENTRY);
    expect(resolveMethod(key, GET_ENTRY).registry).not.toBe(first);
  });
});

describe("encodeRequest", () => {
  it("encodes JSON by the proto3 mapping", () => {
    const method = resolveMethod(LEDGER_DESCRIPTOR_SET, POST_ENTRY);
    const args = {
      accountId: "acct_1",
      kind: "ENTRY_KIND_CREDIT",
      money: { amount: "9007199254740993", currency: "USD" },
      labels: { region: "us" },
      invoiceId: "inv_1",
    };
    const bytes = encodeRequest(method, args);
    expect(toJson(method.input, fromBinary(method.input, bytes), { registry: method.registry })).toEqual(args);
  });

  it("accepts the proto field names too", () => {
    const method = resolveMethod(LEDGER_DESCRIPTOR_SET, POST_ENTRY);
    const bytes = encodeRequest(method, { account_id: "acct_1" });
    expect(toJson(method.input, fromBinary(method.input, bytes))).toEqual({ accountId: "acct_1" });
  });

  it("refuses a field the message does not have", () => {
    const method = resolveMethod(LEDGER_DESCRIPTOR_SET, GET_ENTRY);
    expect(() => encodeRequest(method, { id: "e_1", nope: 1 })).toThrow(
      /^The arguments do not encode as a_intel\.ledger\.v1\.GetEntryRequest: /,
    );
  });
});

describe("decodeResponse", () => {
  const method = resolveMethod(LEDGER_DESCRIPTOR_SET, GET_ENTRY);

  it("writes int64 as a string, enums by name, timestamps as RFC 3339, and every implicit field", () => {
    const bytes = entryBytes(method, {
      id: "e_1",
      kind: "ENTRY_KIND_CREDIT",
      money: { amount: "9007199254740993", currency: "USD" },
      postedAt: "2026-09-26T12:00:00Z",
    });
    expect(decodeResponse(method, bytes)).toEqual({
      id: "e_1",
      accountId: "",
      kind: "ENTRY_KIND_CREDIT",
      money: { amount: "9007199254740993", currency: "USD" },
      postedAt: "2026-09-26T12:00:00Z",
      labels: {},
      relatedIds: [],
      reversed: false,
    });
  });

  it("decodes an Any whose type the descriptor set holds", () => {
    const detail = { "@type": "type.googleapis.com/google.protobuf.Timestamp", value: "2026-01-01T00:00:00Z" };
    const decoded = decodeResponse(method, entryBytes(method, { id: "e_1", detail }));
    expect(decoded).toMatchObject({ id: "e_1", detail });
  });

  it("refuses an Any whose type the descriptor set does not hold", () => {
    // fromJson cannot build an Any of a type it does not know, so build the message directly.
    const detail = create(AnySchema, { typeUrl: "type.googleapis.com/acme.Unknown", value: new Uint8Array([8, 1]) });
    const bytes = toBinary(method.output, create(method.output, { id: "e_1", detail }));
    expect(() => decodeResponse(method, bytes)).toThrow(
      /^The response does not decode as a_intel\.ledger\.v1\.Entry: .*acme\.Unknown/,
    );
  });

  it("refuses bytes that are not the message", () => {
    expect(() => decodeResponse(method, new Uint8Array([0xff]))).toThrow(DescriptorError);
  });
});

describe("messageOf", () => {
  it("reads an Error's message and stringifies anything else", () => {
    expect(messageOf(new Error("socket closed"))).toBe("socket closed");
    expect(messageOf("socket closed")).toBe("socket closed");
    expect(messageOf(42)).toBe("42");
  });
});
