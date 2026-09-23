import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const CREDENTIAL_PATHS = new Set([
  ".aws",
  ".ssh",
  ".gnupg",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
]);

/** Bind mounts carry Unix sockets and nested mounts too; inspect before launch. */
export function validateContainedWorkspace(
  workspace: string,
  sessionDirectory: string,
  mountInfo = readFileSync("/proc/self/mountinfo", "utf8"),
): void {
  const root = realpathSync(workspace);
  const session = realpathSync(sessionDirectory);
  if (root === "/" || within(root, session) || within(session, root))
    throw new Error(
      "Contained configuration and repository must be separate directories",
    );
  for (const line of mountInfo.split("\n")) {
    const raw = line.split(" ")[4];
    if (!raw) continue;
    const mounted = raw.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
    if (mounted !== root && within(root, mounted))
      throw new Error("Contained repository contains a nested mount");
  }
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (CREDENTIAL_PATHS.has(entry) || /^\.env(?:\.|$)/.test(entry))
        throw new Error(
          "Remove local credential files from the contained checkout before launch",
        );
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(path);
        } catch {
          throw new Error(
            "Contained repository contains an unresolved symbolic link",
          );
        }
        if (!within(root, target))
          throw new Error(
            "Contained repository contains a symbolic link outside the checkout",
          );
      } else if (stat.isDirectory()) visit(path);
      else if (!stat.isFile())
        throw new Error(
          "Contained repository contains a socket, device, or pipe",
        );
      else if (stat.nlink > 1)
        throw new Error("Contained repository contains a hard-linked file");
    }
  };
  if (resolve(workspace) !== root)
    throw new Error(
      "Contained repository path must not traverse symbolic links",
    );
  visit(root);
}
