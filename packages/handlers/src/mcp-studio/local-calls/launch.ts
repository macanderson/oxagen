// launch.ts: how a machine starts a local server or a registry package,
// from the lock and server.toml (mcp-studio-spec, Local servers and
// Registry packages).
//
// The lock pins the package and its digest. For a registry package it also
// pins the command and args, with each ${NAME} left for the machine to fill.
// A local server's args and every server's env list come from server.toml.
// env holds names only: the machine fills the values and passes nothing else.
import type { McpLockSource, ServerSource } from "@oxagen/mcp-studio";
import type { LaunchSpec } from "@oxagen/tacho/local-servers";

/** The groups that may run the server: source.machines, or none for a server that runs in the cloud. */
export function machineGroupsOf(source: ServerSource): readonly string[] {
  if (source.type === "local" || source.type === "registry") return source.machines ?? [];
  return [];
}

/**
 * The launch for a server that runs on machines, or undefined when the lock
 * and server.toml describe a server the cloud gateway reaches itself.
 */
export function launchSpecFor(server: string, lockSource: McpLockSource, source: ServerSource): LaunchSpec | undefined {
  if (lockSource.type === "local" && source.type === "local") {
    return {
      server,
      command: lockSource.command,
      args: source.args ?? [],
      env: source.env ?? [],
      package: lockSource.package,
    };
  }
  if (lockSource.type === "registry" && source.type === "registry" && (source.machines?.length ?? 0) > 0) {
    const { command, args, package: pkg } = lockSource;
    if (command === undefined || args === undefined || pkg === undefined) return undefined;
    return { server, command, args, env: source.env ?? [], package: pkg };
  }
  return undefined;
}
