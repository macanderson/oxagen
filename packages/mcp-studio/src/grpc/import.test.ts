// import.test.ts: importGrpc on the ledger fixture and the refusals every
// import makes before it reads a type.
//
// The oracle is the FileDescriptorSet buf build 1.73.0 made from
// fixtures/grpc/ledger.proto (execute/grpc/__tests__/ledger-descriptor-set.ts).
// Import must build the same set from the .proto text, and again from the
// .proto text it prints for a reflection result.
import { equals, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FileDescriptorSetSchema, type FileDescriptorSet } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { documentHash } from "../contract/hashes";
import { formatJson } from "../contract/json";
import { LEDGER_PROTO_SHA256 } from "../execute/grpc/__tests__/ledger-descriptor-set";
import type { ImportedFile, ImportResult } from "../model/import-result";
import { DEFINITION_BYTES_MAX } from "../model/definition-limits";
import { upstreamToolSchema } from "../model/upstream-tool";
import { GrpcImportError, importGrpc, type GrpcImportErrorCode } from "./index";
import { LEDGER_PROTO, ledgerFiles, ledgerOracle, ledgerReflection } from "./__tests__/golden";

const LEDGER = "a_intel.ledger.v1";

/** The descriptor set an import returned, decoded. */
function setOf(result: ImportResult): FileDescriptorSet {
  if (result.descriptor_set === undefined) throw new Error("The import returned no descriptor_set.");
  return fromBinary(FileDescriptorSetSchema, result.descriptor_set);
}

/**
 * Checks that two sets are equal. toJson gives a readable diff when they
 * differ, and equals also compares what JSON does not show.
 */
function expectSameSet(actual: FileDescriptorSet, expected: FileDescriptorSet): void {
  expect(toJson(FileDescriptorSetSchema, actual)).toStrictEqual(toJson(FileDescriptorSetSchema, expected));
  expect(equals(FileDescriptorSetSchema, actual, expected)).toBe(true);
}

/** A copy with every description removed, to compare tools whose source kept no comments. */
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, item]) => [key, withoutDescriptions(item)]),
  );
}

/** The refusal importGrpc throws for the files. */
async function refusal(files: readonly ImportedFile[]): Promise<GrpcImportError> {
  try {
    await importGrpc({ files });
  } catch (error) {
    if (error instanceof GrpcImportError) return error;
    throw error;
  }
  throw new Error("importGrpc accepted the files.");
}

/** Checks the refusal's code, the file it names, and each part its message must hold. */
async function expectRefusal(
  files: readonly ImportedFile[],
  code: GrpcImportErrorCode,
  file: string | undefined,
  ...parts: string[]
): Promise<void> {
  const error = await refusal(files);
  expect(error.code).toBe(code);
  expect(error.file).toBe(file);
  for (const part of parts) expect(error.message).toContain(part);
}

describe("importGrpc with ledger.proto", () => {
  it("builds the descriptor set buf build does", async () => {
    const result = await importGrpc(ledgerFiles());
    expectSameSet(setOf(result), ledgerOracle());
  });

  it("hashes the one file as committed and writes no files", async () => {
    const result = await importGrpc(ledgerFiles());
    expect(result.document_hash).toBe(`sha256:${LEDGER_PROTO_SHA256}`);
    expect(result.document_hash).toBe(documentHash(LEDGER_PROTO));
    expect(result.files).toStrictEqual([]);
    expect(result.environments).toStrictEqual([]);
    expect(result.auth).toStrictEqual([]);
  });

  it("makes a tool of each unary and server-streaming method, in declaration order", async () => {
    const result = await importGrpc(ledgerFiles());
    const request = (method: string, streaming: string, level: string, input: string, output: string): unknown => ({
      kind: "grpc",
      method: `${LEDGER}.Ledger/${method}`,
      streaming,
      idempotency_level: level,
      request_type: `${LEDGER}.${input}`,
      response_type: `${LEDGER}.${output}`,
    });
    expect(result.tools.map((tool) => [tool.name, tool.request])).toStrictEqual([
      ["get_entry", request("GetEntry", "unary", "NO_SIDE_EFFECTS", "GetEntryRequest", "Entry")],
      ["post_entry", request("PostEntry", "unary", "IDEMPOTENCY_UNKNOWN", "PostEntryRequest", "Entry")],
      ["reverse_entry", request("ReverseEntry", "unary", "IDEMPOTENT", "ReverseEntryRequest", "Entry")],
      ["list_entries", request("ListEntries", "server", "NO_SIDE_EFFECTS", "ListEntriesRequest", "Entry")],
    ]);
  });

  it("lists the client-streaming and bidirectional methods and makes no tool of them", async () => {
    const result = await importGrpc(ledgerFiles());
    expect(result.listed.map(({ name, kind }) => [name, kind])).toStrictEqual([
      [`${LEDGER}.Ledger/UploadEntries`, "client_stream"],
      [`${LEDGER}.Ledger/SyncEntries`, "bidi_stream"],
    ]);
    for (const entry of result.listed) expect(entry.reason).toContain("never becomes a tool");
  });

  it("describes each tool with its method's leading comment", async () => {
    const result = await importGrpc(ledgerFiles());
    expect(result.tools.map((tool) => tool.description)).toStrictEqual([
      "Read one entry.",
      "Post an entry. Posting twice posts twice.",
      "Reverse an entry. Reversing it again changes nothing.",
      "Stream every entry for an account, oldest first.",
    ]);
  });

  it("returns a server stream's result as items and truncated", async () => {
    const result = await importGrpc(ledgerFiles());
    const stream = result.tools.find((tool) => tool.name === "list_entries");
    expect(stream?.outputSchema).toMatchObject({
      type: "object",
      properties: { items: { type: "array" }, truncated: { type: "boolean" } },
      required: ["items", "truncated"],
    });
  });

  it("returns tools the UpstreamTool contract accepts", async () => {
    const result = await importGrpc(ledgerFiles());
    for (const tool of result.tools) expect(() => upstreamToolSchema.parse(tool)).not.toThrow();
  });
});

describe("importGrpc with the ledger's reflection result", () => {
  it("prints ledger.proto under proto/ and leaves out the well-known types", async () => {
    const result = await importGrpc(ledgerReflection());
    expect(result.files.map((file) => file.path)).toStrictEqual(["proto/ledger.proto"]);
    expect(result.notes.filter((note) => note.message.includes("google/protobuf/"))).toStrictEqual([]);
  });

  it("reads the printed text back to the descriptor set buf build made", async () => {
    const result = await importGrpc(ledgerReflection());
    expectSameSet(setOf(result), ledgerOracle());
  });

  it("builds the same set from the printed file as from reflection", async () => {
    const reflected = await importGrpc(ledgerReflection());
    const reread = await importGrpc({ files: reflected.files });
    expectSameSet(setOf(reread), setOf(reflected));
  });

  it("prints the same text when it reflects its own set again", async () => {
    const first = await importGrpc(ledgerReflection());
    const protos = setOf(first).file.map((file) => toBinary(FileDescriptorProtoSchema, file));
    const second = await importGrpc({ reflection: { file_descriptor_protos: protos } });
    expect(second.files).toStrictEqual(first.files);
  });

  it("hashes the printed file", async () => {
    const result = await importGrpc(ledgerReflection());
    expect(result.document_hash).toBe(documentHash(result.files[0]?.text ?? ""));
  });

  it("makes the tools the .proto file makes, without the comments reflection does not carry", async () => {
    const fromFile = await importGrpc(ledgerFiles());
    const fromReflection = await importGrpc(ledgerReflection());
    expect(withoutDescriptions(fromReflection.tools)).toStrictEqual(withoutDescriptions(fromFile.tools));
    expect(fromReflection.listed).toStrictEqual(fromFile.listed);
  });
});

describe("importGrpc with several files", () => {
  const money = { path: "proto/money.proto", text: 'syntax = "proto3";\npackage shop;\nmessage Money { int64 amount = 1; }\n' };
  const shop = {
    path: "proto/shop.proto",
    text: [
      'syntax = "proto3";',
      "package shop;",
      'import "money.proto";',
      "service Shop { rpc Price(PriceRequest) returns (Money); }",
      "message PriceRequest { string sku = 1; }",
      "",
    ].join("\n"),
  };

  it("hashes the files sorted by path, whatever order they arrive in", async () => {
    const forward = await importGrpc({ files: [money, shop] });
    const backward = await importGrpc({ files: [shop, money] });
    expect(backward.document_hash).toBe(forward.document_hash);
    expect(forward.document_hash).toBe(documentHash(formatJson([money, shop])));
  });

  it("lists each file after the files it imports", async () => {
    const result = await importGrpc({ files: [shop, money] });
    expect(setOf(result).file.map((file) => file.name)).toStrictEqual(["money.proto", "shop.proto"]);
    expect(result.tools.map((tool) => tool.name)).toStrictEqual(["price"]);
  });
});

describe("importGrpc refuses", () => {
  const proto = (path: string, text = 'syntax = "proto3";\n'): ImportedFile => ({ path, text });

  it("no files", async () => {
    await expectRefusal([], "empty", undefined, "no .proto files", "Pass the files under proto/");
  });

  it("files over 25 MB", async () => {
    const big = proto("proto/big.proto", `// ${"x".repeat(DEFINITION_BYTES_MAX)}\n`);
    await expectRefusal([big], "too_large", undefined, "over 25 MB", "import only the files the services need");
  });

  it("an absolute path", async () => {
    await expectRefusal([proto("/proto/a.proto")], "path", "/proto/a.proto", "outside the server folder");
  });

  it("a path that climbs out of the folder", async () => {
    await expectRefusal([proto("proto/../../a.proto")], "path", "proto/../../a.proto", "outside the server folder");
  });

  it("a path outside proto/", async () => {
    await expectRefusal([proto("a.proto")], "path", "a.proto", "outside proto/", "move the file there");
  });

  it("a file that is not .proto", async () => {
    await expectRefusal([proto("proto/a.txt")], "path", "proto/a.txt", "not a .proto file");
  });

  it("an import that climbs out of proto/", async () => {
    const file = proto("proto/a.proto", 'syntax = "proto3";\nimport "../b.proto";\n');
    await expectRefusal([file], "path", "a.proto", "points outside proto/", "write the path from there");
  });

  it("an import path with a ./ part", async () => {
    const files = [proto("proto/a.proto", 'syntax = "proto3";\nimport "./b.proto";\n'), proto("proto/b.proto")];
    await expectRefusal(files, "path", "a.proto", 'write "b.proto"');
  });

  it("the same file passed twice", async () => {
    await expectRefusal([proto("proto/a.proto"), proto("proto/./a.proto")], "duplicate", "a.proto", "Pass each file once");
  });

  it("the same import written twice", async () => {
    const files = [
      proto("proto/a.proto", 'syntax = "proto3";\nimport "b.proto";\nimport "b.proto";\n'),
      proto("proto/b.proto"),
    ];
    await expectRefusal(files, "duplicate", "a.proto", "imports b.proto twice", "Remove one of the import statements");
  });

  it("a missing import", async () => {
    const file = proto("proto/a.proto", 'syntax = "proto3";\nimport "missing.proto";\n');
    await expectRefusal(
      [file],
      "import_missing",
      "a.proto",
      "a.proto imports missing.proto, which is not among the files",
      "Add proto/missing.proto",
    );
  });

  it("an import cycle of two files", async () => {
    const files = [
      proto("proto/a.proto", 'syntax = "proto3";\nimport "b.proto";\n'),
      proto("proto/b.proto", 'syntax = "proto3";\nimport "a.proto";\n'),
    ];
    await expectRefusal(
      files,
      "import_cycle",
      "a.proto",
      "a.proto imports b.proto and b.proto imports a.proto",
      "move what the files share into a new file",
    );
  });

  it("an import cycle of three files", async () => {
    const files = [
      proto("proto/a.proto", 'syntax = "proto3";\nimport "b.proto";\n'),
      proto("proto/b.proto", 'syntax = "proto3";\nimport "c.proto";\n'),
      proto("proto/c.proto", 'syntax = "proto3";\nimport "a.proto";\n'),
    ];
    await expectRefusal(
      files,
      "import_cycle",
      "a.proto",
      "a.proto imports b.proto, b.proto imports c.proto, and c.proto imports a.proto",
    );
  });

  it("a file that imports itself", async () => {
    const file = proto("proto/a.proto", 'syntax = "proto3";\nimport "a.proto";\n');
    await expectRefusal([file], "import_cycle", "a.proto", "a.proto imports a.proto");
  });

  it("a file that does not parse", async () => {
    await expectRefusal([proto("proto/a.proto", "message {")], "parse", "a.proto", "a.proto does not parse", "Fix the file");
  });

  it("a file that declares an edition", async () => {
    const file = proto("proto/a.proto", 'edition = "2023";\nmessage A { string id = 1; }\n');
    await expectRefusal([file], "unsupported", "a.proto", "declares an edition", 'declare syntax = "proto3"');
  });
});
