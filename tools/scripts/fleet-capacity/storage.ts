import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Refuse job-cleaned locations before enrollment creates remote identities. */
export function persistentOutputRoot(
  value: string,
  ephemeralRoots: readonly string[] = [tmpdir(), "/var/tmp", process.env["RUNNER_TEMP"] ?? "", process.env["GITHUB_WORKSPACE"] ?? ""],
): string {
  if (!isAbsolute(value) || /[\r\n]/.test(value))
    throw new Error("FLEET_OUTPUT_ROOT must name an existing absolute private directory on persistent storage.");
  const root = realpathSync(value);
  for (const ephemeral of ephemeralRoots.filter(Boolean)) {
    const base = realpathSync(ephemeral);
    const path = relative(base, root);
    if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)))
      throw new Error("FLEET_OUTPUT_ROOT must be outside temporary and checkout directories.");
  }
  const info = statSync(root);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
    throw new Error("FLEET_OUTPUT_ROOT must be owned by the runner account with mode 0700.");
  accessSync(root, constants.W_OK | constants.X_OK);
  return resolve(root);
}
