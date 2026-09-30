// Add server's From a definition (#4678, item 1): the server.toml Studio
// writes for a new server and the definition the person uploaded, checked
// before the save so the form names each problem in its own words.
//
// save_studio_draft stores both at revision 0, and open_studio_review opens
// the steering PR that creates tools/servers/<server>/ (ADR-224). The checks
// here mirror the contract's, so a form that passes them should not come back
// server_toml_invalid or source_invalid. Review runs the full checks again.
//
// What this path writes is narrow on purpose, and the PR body records it:
//   - The definition is an upload (`from = "upload"`). A repository or URL
//     source is written in Studio's Connection tab once the folder exists.
//   - Auth is `none`. The Connection tab names a credential afterwards.
//   - One environment, production, carries the URL agents call.
//   - Exposure is direct, and sync is manual or daily. on-change needs a
//     linked repository.
//   - gRPC files go under proto/ by their file name, and OpenAPI files sit
//     beside server.toml, so neither keeps a folder tree.
//
// The module imports only types from the contracts, so the client bundle
// carries no contract code. The name rule is the one in
// packages/oxagen/src/steering-repo/names.ts (SERVER_NAME_PATTERN and
// BUILTIN_SERVER).
import type { StudioSource as DefinitionSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import type { NewStudioServer } from "./review-calls";

/** The definitions Add server takes, in the order the form offers them. */
export const DEFINITION_TYPES = ["openapi", "graphql", "grpc"] as const;
export type DefinitionType = (typeof DEFINITION_TYPES)[number];

/** The sync schedules an uploaded definition may take. */
export const DEFINITION_SCHEDULES = ["manual", "daily"] as const;
type DefinitionSchedule = (typeof DEFINITION_SCHEDULES)[number];

/** A server name: the folder under tools/servers/. */
const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
/** The server name built-in tools use. No MCP server may take it. */
const BUILTIN_SERVER = "builtin";
/** httpUrlSchema's rule: http or https, with no user name or password. */
const HTTP_URL = /^https?:\/\/[^/?#@]*(?:[/?#]|$)/;
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 200;

/** One uploaded file: its name, and its text, or null when it is not UTF-8. */
export type DefinitionFile = { name: string; text: string | null };

/** What the form holds at submit. */
type DefinitionForm = {
  name: string;
  label: string;
  description: string;
  url: string;
  type: DefinitionType;
  schedule: DefinitionSchedule;
  files: readonly DefinitionFile[];
  /** The OpenAPI root document's file name. The other types ignore it. */
  entry: string;
};

/** One thing the form must fix before the save. */
export type DefinitionProblem =
  | {
      kind:
        | "name"
        | "reserved"
        | "label"
        | "description"
        | "url"
        | "files"
        | "entry"
        | "graphqlOne";
    }
  | { kind: "empty" | "duplicate" | "unreadable"; file: string };

/** Pick a schedule from a form value, manual when it is not one. */
export function definitionSchedule(raw: string): DefinitionSchedule {
  return DEFINITION_SCHEDULES.find((option) => option === raw) ?? "manual";
}

/** Pick a definition type from a form value, OpenAPI when it is not one. */
export function definitionType(raw: string): DefinitionType {
  return DEFINITION_TYPES.find((option) => option === raw) ?? "openapi";
}

function isHttpUrl(raw: string): boolean {
  if (!HTTP_URL.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * A TOML basic string. JSON escapes the quote, the backslash and every
 * control character below U+0020 in forms TOML reads the same way. TOML also
 * refuses a raw U+007F, which JSON leaves as it is.
 */
function tomlString(value: string): string {
  return JSON.stringify(value).replaceAll("\u007f", "\\u007F");
}

/** The server.toml Add server writes for an uploaded definition. */
function serverToml(form: DefinitionForm): string {
  return [
    `schema = "mcp-server/v1"`,
    `name = ${tomlString(form.name)}`,
    `label = ${tomlString(form.label)}`,
    `description = ${tomlString(form.description)}`,
    "",
    "[source]",
    `type = ${tomlString(form.type)}`,
    `from = "upload"`,
    "",
    "[auth]",
    `mode = "none"`,
    "",
    "[environments.production]",
    `url = ${tomlString(form.url)}`,
    "",
    "[exposure]",
    `mode = "direct"`,
    "",
    "[sync]",
    `schedule = ${tomlString(form.schedule)}`,
    "",
  ].join("\n");
}

/** The problems with the uploaded files, for the type the form names. */
function fileProblems(form: DefinitionForm): DefinitionProblem[] {
  if (form.files.length === 0) return [{ kind: "files" }];
  const problems: DefinitionProblem[] = [];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const file of form.files) {
    if (seen.has(file.name)) repeated.add(file.name);
    seen.add(file.name);
    if (file.text === null) {
      problems.push({ kind: "unreadable", file: file.name });
    } else if (file.text.trim() === "") {
      problems.push({ kind: "empty", file: file.name });
    }
  }
  for (const file of repeated) problems.push({ kind: "duplicate", file });
  if (form.type === "graphql" && form.files.length !== 1) {
    problems.push({ kind: "graphqlOne" });
  }
  if (
    form.type === "openapi" &&
    !form.files.some((file) => file.name === form.entry)
  ) {
    problems.push({ kind: "entry" });
  }
  return problems;
}

/** The definition as save_studio_draft takes it. Every file has its text. */
function definitionSource(
  type: DefinitionType,
  files: readonly { name: string; text: string }[],
  entry: string,
): DefinitionSource {
  switch (type) {
    case "openapi":
      return {
        type,
        files: files.map((file) => ({ path: file.name, text: file.text })),
        entry,
      };
    case "graphql":
      return { type, sdl: files[0]?.text ?? "" };
    case "grpc":
      return {
        type,
        files: files.map((file) => ({
          path: `proto/${file.name}`,
          text: file.text,
        })),
      };
  }
}

/**
 * Check the form and build the new server's draft, or name every problem.
 * Text fields are trimmed first, so a stray space never fails the contract.
 */
export function newDefinitionServer(
  raw: DefinitionForm,
):
  | { ok: true; server: NewStudioServer }
  | { ok: false; problems: readonly DefinitionProblem[] } {
  const form: DefinitionForm = {
    ...raw,
    name: raw.name.trim(),
    label: raw.label.trim(),
    description: raw.description.trim(),
    url: raw.url.trim(),
  };
  const problems: DefinitionProblem[] = [];
  if (form.name === BUILTIN_SERVER) {
    problems.push({ kind: "reserved" });
  } else if (!SERVER_NAME_PATTERN.test(form.name)) {
    problems.push({ kind: "name" });
  }
  if (form.label === "" || form.label.length > LABEL_MAX) {
    problems.push({ kind: "label" });
  }
  if (form.description === "" || form.description.length > DESCRIPTION_MAX) {
    problems.push({ kind: "description" });
  }
  if (!isHttpUrl(form.url)) problems.push({ kind: "url" });
  problems.push(...fileProblems(form));
  if (problems.length > 0) return { ok: false, problems };

  const files = form.files.flatMap((file) =>
    file.text === null ? [] : [{ name: file.name, text: file.text }],
  );
  return {
    ok: true,
    server: {
      server: form.name,
      serverToml: serverToml(form),
      source: definitionSource(form.type, files, form.entry),
    },
  };
}
