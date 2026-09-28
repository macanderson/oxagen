// errors.ts: the one error OpenAPI import throws, with a stable code.
//
// Every refusal says what happened and what to do. A caller branches on
// `code`, and on `ref` or `limit` when the code names one.

export type OpenApiImportErrorCode =
  /** The document, or the overlay, is over DEFINITION_BYTES_MAX. */
  | "too_large"
  /** A file is not YAML or JSON. */
  | "parse"
  /** The document has no openapi or swagger field. */
  | "not_openapi"
  /** The document is an OpenAPI version import does not read, such as 3.2. */
  | "unsupported_version"
  /** A $ref names a URL, an absolute path, or a file outside the folder. */
  | "ref_outside"
  /** A $ref names a file or a location that does not exist. */
  | "ref_missing"
  /** A chain of $refs leads back to itself with no schema between. */
  | "ref_cycle"
  /** Import produced more nodes than its limit. */
  | "expansion_limit"
  /** A document or a schema nests deeper than its limit. */
  | "depth_limit"
  /** overlay.yaml is not a valid Overlay 1.0 document. */
  | "overlay"
  /** The Swagger 2.0 or OpenAPI 3.0 converter failed. */
  | "convert";

export interface OpenApiImportErrorDetail {
  /** The $ref the error is about. */
  ref?: string;
  /** The limit the document passed. */
  limit?: number;
}

export class OpenApiImportError extends Error {
  readonly code: OpenApiImportErrorCode;
  readonly ref: string | undefined;
  readonly limit: number | undefined;

  constructor(code: OpenApiImportErrorCode, message: string, detail: OpenApiImportErrorDetail = {}) {
    super(message);
    this.name = "OpenApiImportError";
    this.code = code;
    this.ref = detail.ref;
    this.limit = detail.limit;
  }
}

/** A count for a message: 25,000,000. */
export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** The first line of an error's message, for a refusal that quotes a library's error. */
export function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n")[0]?.trim() ?? "";
  return line.replace(/[.:]+$/, "");
}
