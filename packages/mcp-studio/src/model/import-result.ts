// import-result.ts: what every importer returns (lanes M1, M2, and M3).
import type { Sha256Digest } from "@oxagen/run-evidence";
import type { SecurityScheme } from "./security-scheme";
import type { UpstreamTool } from "./upstream-tool";

/** Why a definition entry is listed and never becomes a tool (mcp-studio-spec, Definition import). */
export type ListedKind = "webhook" | "callback" | "subscription" | "client_stream" | "bidi_stream";

/** An entry of the definition that is listed and never imported. */
export interface ListedEntry {
  name: string;
  kind: ListedKind;
  reason: string;
}

/** Something import changed or cut, such as a recursive schema cut at depth 4. */
export interface ImportNote {
  /** The UpstreamTool name the note is about, or undefined for the whole document. */
  tool: string | undefined;
  message: string;
}

/** An environment the definition suggests: OpenAPI's servers. */
export interface SuggestedEnvironment {
  url: string;
  description: string | undefined;
}

/** An auth choice the definition offers: an entry of OpenAPI's components.securitySchemes. */
export type SuggestedAuth = SecurityScheme & {
  /** The key server.toml's auth.scheme names. */
  scheme: string;
};

/** A file import writes into the server's folder: a bundled document, or .proto text from reflection. */
export interface ImportedFile {
  /** Relative to the server's folder: openapi.yaml, proto/a_intel/ledger/v1/ledger.proto. */
  path: string;
  text: string;
}

export interface ImportResult {
  tools: UpstreamTool[];
  listed: ListedEntry[];
  notes: ImportNote[];
  environments: SuggestedEnvironment[];
  auth: SuggestedAuth[];
  /** SHA-256 of the definition's bytes as committed: one file, or the bundle. */
  document_hash: Sha256Digest;
  files: ImportedFile[];
  /** gRPC only: the serialized FileDescriptorSet the executor encodes and decodes with. */
  descriptor_set: Uint8Array | undefined;
}
