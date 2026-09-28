// server.ts: the checks on server.toml as a whole: its name, its credential
// references, and where a local server runs.
import { SERVER_NAME_PATTERN } from "@oxagen/oxagen/steering-repo/names";
import type { LintContext, ServerFolder } from "./index";
import type { Report } from "./report";

/** Every credential reference in server.toml, with the field that holds it. */
function credentialFields(folder: ServerFolder): [field: string, ref: string][] {
  const { server } = folder;
  const found: [string, string][] = [];
  if (server.auth?.credential !== undefined) found.push(["auth.credential", server.auth.credential]);
  for (const [name, environment] of Object.entries(server.environments ?? {})) {
    if (environment.credential !== undefined) found.push([`environments.${name}.credential`, environment.credential]);
  }
  return found;
}

export function lintServer(folder: ServerFolder, context: LintContext, report: Report): void {
  const { server } = folder;

  if (!SERVER_NAME_PATTERN.test(server.name)) {
    report("invalid_name", {
      tool: undefined,
      field: "name",
      message: `The server name ${JSON.stringify(server.name)} breaks every tool name, and model APIs reject a tool name that breaks the pattern.`,
      fix: "Rename the server to at most 24 lowercase letters, digits, and underscores, starting with a letter.",
    });
  }

  for (const [field, ref] of credentialFields(folder)) {
    if (context.credentials.has(ref)) continue;
    report("unknown_credential", {
      tool: undefined,
      field,
      message: `${field} names ${ref}, and the organization has no credential by that name, so every call would fail.`,
      fix: `Add ${ref} in Oxagen, or set ${field} to a credential the organization has.`,
    });
  }

  const { source } = server;
  if (source.type === "local" && (source.machines ?? []).length === 0) {
    report("local_without_machines", {
      tool: undefined,
      field: "source.machines",
      message: "The server names no machine group, so it runs nowhere.",
      fix: "Add the machine groups that run it to source.machines in server.toml.",
    });
  }
}
