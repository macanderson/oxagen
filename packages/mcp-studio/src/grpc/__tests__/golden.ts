// golden.ts: the ledger fixture as importGrpc input, read from its .proto file
// and as server reflection returns it, and the value each golden file pins.
// scripts/write-grpc-expected.ts writes the goldens with these, and
// golden.test.ts checks them with the same functions.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FileDescriptorSetSchema, type FileDescriptorSet } from "@bufbuild/protobuf/wkt";
import { LEDGER_DESCRIPTOR_SET } from "../../execute/grpc/__tests__/ledger-descriptor-set";
import type { ImportResult } from "../../model/import-result";
import type { GrpcInput } from "..";

export const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
export const GRPC_EXPECTED = `${FIXTURES}expected/grpc/`;

/** fixtures/grpc/ledger.proto as committed. */
export const LEDGER_PROTO = readFileSync(`${FIXTURES}grpc/ledger.proto`, "utf8");

/** The FileDescriptorSet buf build made from ledger.proto: any.proto, timestamp.proto, then ledger.proto. */
export function ledgerOracle(): FileDescriptorSet {
  return fromBinary(FileDescriptorSetSchema, Buffer.from(LEDGER_DESCRIPTOR_SET, "base64"));
}

/** ledger.proto as the one file under proto/. */
export function ledgerFiles(): GrpcInput {
  return { files: [{ path: "proto/ledger.proto", text: LEDGER_PROTO }] };
}

/** What server reflection returns for the ledger service: each file of the oracle, serialized. */
export function ledgerReflection(): GrpcInput {
  const protos = ledgerOracle().file.map((file) => toBinary(FileDescriptorProtoSchema, file));
  return { reflection: { file_descriptor_protos: protos } };
}

/** Each golden's name, and the input it is imported from. */
export const GOLDENS: Record<string, () => GrpcInput> = {
  ledger: ledgerFiles,
  "ledger-reflection": ledgerReflection,
};

/** The .proto text import prints from the reflection result, kept as a file so a reviewer reads it as .proto. */
export const REFLECTED_PROTO = `${GRPC_EXPECTED}ledger-reflection.proto`;

/**
 * What a golden pins: the whole result except descriptor_set, whose bytes
 * the oracle test in import.test.ts checks against buf build's.
 */
export function goldenValue(result: ImportResult): unknown {
  return { ...result, descriptor_set: undefined };
}
