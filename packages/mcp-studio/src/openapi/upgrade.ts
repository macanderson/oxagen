// upgrade.ts: every document as OpenAPI 3.1, in memory.
//
// Swagger 2.0 and OpenAPI 3.0 go through @scalar/openapi-upgrader, which
// rewrites 3.0's `nullable: true` as a type list and 2.0's host, basePath,
// and schemes as servers. The file in the folder keeps its own version.
import { upgrade } from "@scalar/openapi-upgrader";
import type { ImportNote } from "../model/import-result";
import { OpenApiImportError, firstLine } from "./errors";
import { isRecord, type JsonRecord } from "./json";

export type OpenApiVersion = "2.0" | "3.0" | "3.1";

/**
 * The version a parsed document declares. YAML reads `openapi: 3.0` and
 * `swagger: 2.0` as numbers, so a number counts too.
 */
export function detectVersion(document: unknown, entry: string): OpenApiVersion {
  if (!isRecord(document) || (document.openapi === undefined && document.swagger === undefined)) {
    throw new OpenApiImportError(
      "not_openapi",
      `${entry} has no openapi or swagger field, so it is not an OpenAPI document. ` +
        "Point the source at the OpenAPI document and import again.",
    );
  }
  const { openapi, swagger } = document;
  if (swagger === "2.0" || swagger === 2) return "2.0";
  const version = typeof openapi === "number" ? openapi.toFixed(1) : openapi;
  if (typeof version === "string") {
    if (/^3\.1(?:\.\d+)?(?:-[\w.]+)?$/.test(version)) return "3.1";
    if (/^3\.0(?:\.\d+)?(?:-[\w.]+)?$/.test(version)) return "3.0";
  }
  throw new OpenApiImportError(
    "unsupported_version",
    `${entry} ${declaredVersion(openapi, swagger, version)}. Import reads OpenAPI 3.1 and 3.0, and Swagger 2.0. ` +
      "Convert the document to one of those versions and import again.",
  );
}

/** What an unsupported document declares, as the rest of a sentence that opens with its path. */
function declaredVersion(openapi: unknown, swagger: unknown, version: unknown): string {
  if (typeof version === "string") return `is OpenAPI ${version}`;
  if (openapi !== undefined) return "has an openapi field that is not a version number";
  if (typeof swagger === "string" || typeof swagger === "number") return `is Swagger ${String(swagger)}`;
  return "has a swagger field that is not a version number";
}

/** The document as OpenAPI 3.1. It converts in place, so the caller passes a copy it owns. */
export function upgradeDocument(document: JsonRecord, version: OpenApiVersion, notes: ImportNote[]): JsonRecord {
  if (version === "3.1") {
    document.openapi = typeof document.openapi === "string" ? document.openapi : "3.1.0";
    return document;
  }
  // The converter checks for a version string, and YAML may have read a number.
  if (version === "2.0") document.swagger = "2.0";
  else document.openapi = typeof document.openapi === "string" ? document.openapi : "3.0.0";

  let upgraded: unknown;
  try {
    upgraded = upgrade(document, "3.1");
  } catch (error) {
    throw new OpenApiImportError(
      "convert",
      `Import could not convert the OpenAPI ${version} document to 3.1: ${firstLine(error)}. ` +
        "Convert the document to OpenAPI 3.1 and import again.",
    );
  }
  if (!isRecord(upgraded)) {
    throw new OpenApiImportError(
      "convert",
      `Import could not convert the OpenAPI ${version} document to 3.1. Convert the document to OpenAPI 3.1 and import again.`,
    );
  }
  if (version === "2.0") {
    notes.push({
      tool: undefined,
      message: "Import converted the Swagger 2.0 document to OpenAPI 3.1 in memory. The file in the folder stays Swagger 2.0.",
    });
  }
  return upgraded;
}
