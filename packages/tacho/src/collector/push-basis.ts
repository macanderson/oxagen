/**
 * Which credential a recorded `git push` went out with (ADR-151, #3788).
 *
 * `tacho github configure` rewrites a repository's GitHub remotes to the
 * daemon's loopback Git proxy and records a receipt in the host file. A push
 * through that proxy is `gateway_brokered`: the daemon attached a scoped
 * installation token the harness never saw. Any other push is
 * `harness_held`: a personal token, a keychain helper, an SSH key, or a URL
 * with a token in it.
 *
 * The answer is client-attested, like every hook record (ADR-040 section 4).
 * It comes from the command line, the receipt, and the remote's push URLs as
 * Git reports them after the push. It does not prove which credential Git
 * used. The proof is the `token_use` frame the proxy seals, and this
 * attribute lets a reader count the pushes that have none.
 */
import { resolve } from "node:path";
import { gitSubcommand, tokenizeSimpleCommand } from "../claude-code/tools";
import type { HostFile } from "../host/host-file";
import type { ExecAsync } from "../host/service";
import {
  TACHO_CREDENTIAL_GATEWAY_BROKERED,
  TACHO_CREDENTIAL_HARNESS_HELD,
  type TachoCredentialBasis,
} from "../wire";

type CustodyReceipt = NonNullable<HostFile["github_repositories"]>[number];

/** `git push` options that take their value as the next token. */
const PUSH_OPTIONS_WITH_VALUE = new Set([
  "--repo",
  "-o",
  "--push-option",
  "--receive-pack",
  "--exec",
]);

/**
 * Global options that can move the push somewhere the receipt does not
 * describe: another repository, another config, another remote URL. A push
 * that carries one is harness-held, because this module cannot say where it
 * went.
 */
const GLOBAL_OPTIONS_THAT_REDIRECT = new Set([
  "-c",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

export interface GitPushTarget {
  /** Each `-C` directory in order, relative to the one before it. */
  chdir: string[];
  /** The repository argument: a remote name or a URL. Absent means Git's default. */
  remote?: string;
}

/**
 * The directory changes and the remote of a `git push` command line, or
 * undefined when the line is not one this module can read. Undefined makes
 * the push harness-held.
 */
export function gitPushTarget(command: string): GitPushTarget | undefined {
  const tokens = tokenizeSimpleCommand(command);
  if (tokens === undefined || tokens[0] !== "git") return undefined;
  const subcommand = gitSubcommand(tokens);
  if (subcommand?.name !== "push") return undefined;
  const chdir: string[] = [];
  for (let i = 1; i < subcommand.index; i += 1) {
    const token = tokens[i] as string;
    const base = token.split("=", 1)[0] as string;
    if (GLOBAL_OPTIONS_THAT_REDIRECT.has(base)) return undefined;
    if (token === "-C") {
      chdir.push(tokens[i + 1] as string);
      i += 1;
    }
  }
  const args = tokens.slice(subcommand.index + 1);
  let remote: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token === "--") {
      remote ??= args[i + 1];
      break;
    }
    if (token.startsWith("--repo=")) {
      remote = token.slice("--repo=".length);
      continue;
    }
    if (PUSH_OPTIONS_WITH_VALUE.has(token)) {
      if (token === "--repo") remote = args[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    remote ??= token;
    break;
  }
  return { chdir, ...(remote !== undefined ? { remote } : {}) };
}

export interface PushBasisDeps {
  /** The host file's custody receipts, read when the push is recorded. */
  receipts: () => readonly CustodyReceipt[];
  execAsync: ExecAsync;
}

/**
 * The basis for one `git push` run in `cwd`.
 *
 * `gateway_brokered` needs two things: a receipt for the directory the push
 * ran in, and every push URL Git now reports for the remote equal to that
 * receipt's proxy URL. Git expands `insteadOf` and `pushInsteadOf` when it
 * reports them, so a rewrite that sends the push elsewhere is seen. A remote
 * named by URL is its own push URL. Everything else is `harness_held`,
 * including a failed Git read, because nothing then shows the proxy carried
 * the push.
 */
export async function pushCredentialBasis(
  command: string,
  cwd: string | undefined,
  deps: PushBasisDeps,
): Promise<TachoCredentialBasis> {
  const receipts = deps.receipts();
  if (cwd === undefined || receipts.length === 0)
    return TACHO_CREDENTIAL_HARNESS_HELD;
  const target = gitPushTarget(command);
  if (target === undefined) return TACHO_CREDENTIAL_HARNESS_HELD;
  const dir = target.chdir.reduce((from, to) => resolve(from, to), cwd);
  const receipt = receipts.find((entry) => resolve(entry.cwd) === dir);
  if (receipt === undefined) return TACHO_CREDENTIAL_HARNESS_HELD;
  // With no repository argument, Git pushes to the branch's push remote, or
  // `origin` when none is set. `configure` rewrites the remotes that named
  // this repository, and `origin` is the one a clone creates.
  const remote = target.remote ?? (await defaultPushRemote(dir, deps));
  const urls = await pushUrls(dir, remote, deps);
  return urls.length > 0 && urls.every((url) => url === receipt.url)
    ? TACHO_CREDENTIAL_GATEWAY_BROKERED
    : TACHO_CREDENTIAL_HARNESS_HELD;
}

async function gitOut(
  dir: string,
  args: string[],
  deps: PushBasisDeps,
): Promise<string | undefined> {
  const result = await deps.execAsync("git", ["-C", dir, ...args]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function defaultPushRemote(
  dir: string,
  deps: PushBasisDeps,
): Promise<string> {
  const branch = await gitOut(dir, ["symbolic-ref", "--short", "HEAD"], deps);
  for (const key of [
    ...(branch ? [`branch.${branch}.pushRemote`] : []),
    "remote.pushDefault",
    ...(branch ? [`branch.${branch}.remote`] : []),
  ]) {
    const value = await gitOut(dir, ["config", "--get", key], deps);
    if (value) return value;
  }
  return "origin";
}

async function pushUrls(
  dir: string,
  remote: string,
  deps: PushBasisDeps,
): Promise<string[]> {
  const named = await gitOut(
    dir,
    ["remote", "get-url", "--push", "--all", remote],
    deps,
  );
  if (named !== undefined)
    return named.split("\n").filter((line) => line.length > 0);
  // Not a configured remote, so Git read the argument as a URL or a path.
  return [remote];
}
