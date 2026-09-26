// run-command-refs.ts — the issues and releases a wrapped session's frames
// name (#3970, #3890, ADR-197).
//
// Two sources name them. The server parses the command head a shell frame
// keeps as `tool_target` (at most 512 characters, `tacho/claude-code/tools.ts`):
// `gh issue <verb> <N|URL>`, `gh api repos/o/r/issues/N`, a literal
// `github.com/o/r/issues/N` URL, and `gh release create <tag>`. The recorder
// writes `issue.*` attrs on the effect frame of a GitHub MCP issue tool and of
// `gh issue create` (`issueAttrs`), which reach hosts with a later desktop
// release, so the command parse stands on its own for every frame recorded
// before it.
//
// Every parser here is pure and conservative. A line is cut into simple
// commands the way the recorder cuts it (`splitCommandList`), each command is
// tokenized the way the recorder tokenizes it (`tokenizeSimpleCommand`), and a
// flag this file does not know stops the read of that command rather than
// letting the flag's value read as an issue number. A command that only
// prints text (`echo gh issue view 3`) is not a `gh` command, and a
// here-document body is text, not commands.
import {
  RUN_ISSUE_ACTIONS,
  type RunIssue,
} from "@oxagen/oxagen/contracts/run.issues.get";
import type {
  RunCheckout,
  RunRepository,
} from "@oxagen/oxagen/contracts/run.work.get";
import { splitCommandList, tokenizeSimpleCommand } from "@oxagen/tacho/claude-code";
import { chSelect } from "@oxagen/telemetry";
import type { ConnectedRunRepository } from "./run-work";

export type RunIssueAction = RunIssue["actions"][number];

/** A repository as a frame names it. */
export interface NamedRepository {
  owner: string;
  name: string;
}

/** One issue a frame names, before its repository is resolved. */
export interface IssueRef {
  /** Null for a bare `#N` whose command names no repository. */
  repository: NamedRepository | null;
  number: number;
  action: RunIssueAction;
  /** The issue URL the frame spelled out; null when it named a number only. */
  url: string | null;
}

/** One release a frame created, before its repository is resolved. */
export interface ReleaseRef {
  /** Null when the command names no repository (`-R` or `GH_REPO`). */
  repository: NamedRepository | null;
  tag: string;
}

const SEGMENT = /^[\w.-]+$/;

function repositoryOf(value: string | undefined | null): NamedRepository | null {
  if (!value) return null;
  // `gh -R` also takes `HOST/OWNER/REPO`. Only github.com is read here.
  const parts = value.split("/");
  const [owner, name] =
    parts.length === 3 && parts[0] === "github.com"
      ? [parts[1], parts[2]]
      : parts.length === 2
        ? [parts[0], parts[1]]
        : [undefined, undefined];
  if (!owner || !name || !SEGMENT.test(owner) || !SEGMENT.test(name))
    return null;
  return { owner, name };
}

const ISSUE_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\b/g;

/** An issue URL, as its repository and number; null for anything else. */
export function issueOfUrl(
  value: string,
): { repository: NamedRepository; number: number; url: string } | null {
  const match = new RegExp(`^${ISSUE_URL.source}`).exec(value);
  if (match === null) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return {
    repository: { owner: match[1] ?? "", name: match[2] ?? "" },
    number,
    url: match[0],
  };
}

function positiveInt(value: string | undefined): number | null {
  if (value === undefined || !/^#?\d+$/.test(value)) return null;
  const number = Number(value.replace(/^#/, ""));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * The left side of the first unquoted single `|`, with `2>&1` style
 * redirections removed. The recorder's tokenizer refuses a pipe or an `&`
 * outright, but `gh issue view 3 | head` and `gh issue view 3 2>&1` still run
 * the `gh` command, and what follows the pipe only reads its output.
 */
function commandOfPiece(piece: string): string {
  let quote: '"' | "'" | undefined;
  let end = piece.length;
  for (let i = 0; i < piece.length; i += 1) {
    const char = piece[i];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "\\") i += 1;
    else if (char === "|") {
      end = i;
      break;
    }
  }
  return piece.slice(0, end).replace(/(^|\s)\d*[<>]&\d+(?=\s|$)/g, "$1");
}

/** A tokenized `gh` command: the environment it names, then its arguments. */
function ghArguments(tokens: readonly string[]): {
  args: string[];
  envRepository: string | null;
} | null {
  let envRepository: string | null = null;
  let i = 0;
  // `GH_REPO=o/r gh issue view 3`: gh reads the repository from GH_REPO.
  for (; i < tokens.length; i += 1) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tokens[i] ?? "");
    if (assignment === null) break;
    if (assignment[1] === "GH_REPO") envRepository = assignment[2] ?? null;
  }
  const program = tokens[i];
  if (program === undefined || program.split("/").at(-1) !== "gh") return null;
  return { args: tokens.slice(i + 1), envRepository };
}

/** The simple commands of one frame's command head, each tokenized. */
function commandsOf(command: string): { text: string; tokens: string[] }[] {
  const commands: { text: string; tokens: string[] }[] = [];
  for (const piece of splitCommandList(command)) {
    const tokens = tokenizeSimpleCommand(commandOfPiece(piece));
    commands.push({ text: piece, tokens: tokens ?? [] });
  }
  return commands;
}

/**
 * The flags that take a separate value, per `gh issue` verb (gh 2.x). A short
 * flag can mean one thing under one verb and another under the next: `-c` is
 * `--comments` (no value) under `view` and `--comment` (a value) under
 * `close`, and `-l` is `--label` under `create` and `--list` under `develop`.
 */
const ISSUE_VALUE_FLAGS: Record<string, readonly string[]> = {
  view: ["--json", "-q", "--jq", "-t", "--template"],
  comment: ["-b", "--body", "-F", "--body-file"],
  create: [
    "-t",
    "--title",
    "-b",
    "--body",
    "-F",
    "--body-file",
    "-a",
    "--assignee",
    "-l",
    "--label",
    "-m",
    "--milestone",
    "-p",
    "--project",
    "-T",
    "--template",
    "--recover",
  ],
  edit: [
    "-t",
    "--title",
    "-b",
    "--body",
    "-F",
    "--body-file",
    "--add-assignee",
    "--remove-assignee",
    "--add-label",
    "--remove-label",
    "--add-project",
    "--remove-project",
    "-m",
    "--milestone",
  ],
  close: ["-c", "--comment", "-r", "--reason", "--duplicate-of"],
  reopen: ["-c", "--comment"],
  develop: ["-b", "--base", "-n", "--name", "--branch-repo"],
  lock: ["-r", "--reason"],
};

/** The flags that take no value, per verb; any verb also takes `-w`/`--web`. */
const ISSUE_BOOL_FLAGS: Record<string, readonly string[]> = {
  view: ["-c", "--comments"],
  comment: ["-e", "--editor", "--edit-last", "--create-if-none", "--yes"],
  create: ["-e", "--editor"],
  edit: ["--remove-milestone"],
  develop: ["-c", "--checkout", "-l", "--list"],
  close: [],
  reopen: [],
  lock: [],
};

/** What each `gh issue` verb that names one issue does to it. */
const ISSUE_VERB_ACTIONS: Record<string, RunIssueAction> = {
  view: "viewed",
  comment: "commented",
  edit: "edited",
  close: "closed",
  reopen: "reopened",
  // A linked branch, a pin, a lock and a transfer all change the issue.
  develop: "edited",
  pin: "edited",
  unpin: "edited",
  lock: "edited",
  unlock: "edited",
  transfer: "edited",
};

/**
 * The positional arguments of a `gh <group> <verb> …` command, with the
 * repository its `-R`/`--repo` names. Null for a help request, or when a flag
 * this parser does not know comes before the target, since its value could
 * then read as the target.
 */
function ghPositionals(
  args: readonly string[],
  valueFlags: (verb: string | undefined) => ReadonlySet<string>,
  boolFlags: (verb: string | undefined) => ReadonlySet<string>,
  targetIndex: number,
): { positionals: string[]; repository: string | null } | null {
  const positionals: string[] = [];
  let repository: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (token === "-h" || token === "--help") return null;
    if (token === "-R" || token === "--repo") {
      repository = args[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token.startsWith("--repo=")) {
      repository = token.slice("--repo=".length);
      continue;
    }
    if (/^-R[^-]/.test(token)) {
      repository = token.slice(2);
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const verb = positionals[1];
      if (token.includes("=")) continue;
      if (valueFlags(verb).has(token)) {
        i += 1;
        continue;
      }
      if (boolFlags(verb).has(token)) continue;
      if (positionals.length <= targetIndex) return null;
      continue;
    }
    positionals.push(token);
  }
  return { positionals, repository };
}

const WEB_FLAGS = ["-w", "--web"];

function issueFlags(
  table: Record<string, readonly string[]>,
  extra: readonly string[] = [],
) {
  return (verb: string | undefined) =>
    new Set([...(verb === undefined ? [] : (table[verb] ?? [])), ...extra]);
}

/** `gh issue <verb> <N|URL>`: the issues one command names. */
function ghIssueRefs(
  args: readonly string[],
  envRepository: string | null,
): IssueRef[] {
  const read = ghPositionals(
    args,
    issueFlags(ISSUE_VALUE_FLAGS),
    issueFlags(ISSUE_BOOL_FLAGS, WEB_FLAGS),
    2,
  );
  if (read === null) return [];
  const [group, verb, ...targets] = read.positionals;
  if (group !== "issue" || verb === undefined) return [];
  const action = ISSUE_VERB_ACTIONS[verb];
  if (action === undefined) return [];
  // `gh issue edit` takes several issues; every other verb names one, and
  // `transfer`'s second argument is the destination repository.
  const named = verb === "edit" ? targets : targets.slice(0, 1);
  const spelled = read.repository ?? envRepository;
  const repository = repositoryOf(spelled);
  // A repository this parser cannot read (another host, a typo) is not read
  // as "no repository", which would resolve the number against the checkout.
  if (spelled !== null && repository === null) return [];
  const refs: IssueRef[] = [];
  for (const target of named) {
    const fromUrl = issueOfUrl(target);
    if (fromUrl !== null) {
      refs.push({ ...fromUrl, action });
      continue;
    }
    const number = positiveInt(target);
    if (number === null) {
      // A word where the issue should be ends the read: `gh issue edit 3 x`
      // names 3, never x.
      break;
    }
    refs.push({ repository, number, action, url: null });
  }
  return refs;
}

const API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "-p",
  "--preview",
  "--cache",
]);
const API_BOOL_FLAGS = new Set([
  "-i",
  "--include",
  "--paginate",
  "--silent",
  "--verbose",
  "--slurp",
]);
const API_FIELD_FLAGS = new Set(["-f", "--raw-field", "-F", "--field"]);

/** `gh api [-X M] repos/o/r/issues/N[/…]`: the issue one REST call names. */
function ghApiRef(
  args: readonly string[],
  envRepository: string | null,
): IssueRef | null {
  if (args[0] !== "api") return null;
  let method: string | null = null;
  let hasBody = false;
  const fields: string[] = [];
  let endpoint: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token === "-h" || token === "--help") return null;
    // `--method=PATCH` carries its value inline; a short flag never does here.
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    if (API_VALUE_FLAGS.has(flag)) {
      const value = inline ?? args[i + 1];
      if (inline === undefined) i += 1;
      if (flag === "-X" || flag === "--method")
        method = (value ?? "").toUpperCase();
      if (API_FIELD_FLAGS.has(flag) || flag === "--input") hasBody = true;
      if (API_FIELD_FLAGS.has(flag) && value !== undefined) fields.push(value);
      continue;
    }
    if (API_BOOL_FLAGS.has(flag)) continue;
    if (token.startsWith("-")) {
      if (endpoint === undefined) return null;
      continue;
    }
    endpoint ??= token;
  }
  if (endpoint === undefined) return null;
  const match =
    /^\/?repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/([^?#]*))?(?:\?.*)?$/.exec(
      endpoint,
    );
  if (match === null) return null;
  const number = positiveInt(match[3]);
  if (number === null) return null;
  // `{owner}/{repo}` is gh's placeholder for the checkout's own repository.
  const placeholder = match[1] === "{owner}" && match[2] === "{repo}";
  const repository = placeholder
    ? repositoryOf(envRepository)
    : repositoryOf(`${match[1] ?? ""}/${match[2] ?? ""}`);
  if (repository === null && !placeholder) return null;
  const verb = method ?? (hasBody ? "POST" : "GET");
  const suffix = (match[4] ?? "").replace(/\/$/, "");
  let action: RunIssueAction;
  if (verb === "GET") action = "viewed";
  else if (suffix === "comments" && verb === "POST") action = "commented";
  else if (suffix === "" && verb === "PATCH") {
    action = fields.includes("state=closed")
      ? "closed"
      : fields.includes("state=open")
        ? "reopened"
        : "edited";
  } else action = "edited";
  return { repository, number, action, url: null };
}

/** The key two refs to one issue share, repository or not. */
function refKey(ref: {
  repository: NamedRepository | null;
  number: number;
}): string {
  const repo = ref.repository;
  return repo === null
    ? `#${String(ref.number)}`
    : `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${String(ref.number)}`;
}

/**
 * The issues one command head names, in the order it names them: each
 * `gh issue <verb>` and `gh api …/issues/N` command with what it does, then
 * every other `github.com/o/r/issues/N` URL in the line as `mentioned`.
 * `gh issue list`, `gh issue create` (which names no number until it runs),
 * `gh pr view 12`, `gh issue view --help` and `echo gh issue view 3` name
 * none.
 */
export function issueRefsOfCommand(command: string): IssueRef[] {
  const refs: IssueRef[] = [];
  const seen = new Set<string>();
  const add = (ref: IssueRef) => {
    const key = `${refKey(ref)}:${ref.action}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const { text, tokens } of commandsOf(command)) {
    const gh = ghArguments(tokens);
    const named = new Set<string>();
    if (gh !== null) {
      const fromCommand = [
        ...ghIssueRefs(gh.args, gh.envRepository),
        ...[ghApiRef(gh.args, gh.envRepository)].filter(
          (ref): ref is IssueRef => ref !== null,
        ),
      ];
      for (const ref of fromCommand) {
        named.add(refKey(ref));
        add(ref);
      }
    }
    for (const match of text.matchAll(ISSUE_URL)) {
      const url = issueOfUrl(match[0]);
      if (url === null || named.has(refKey(url))) continue;
      add({ ...url, action: "mentioned" });
    }
  }
  return refs;
}

const RELEASE_VALUE_FLAGS = new Set([
  "-t",
  "--title",
  "-n",
  "--notes",
  "-F",
  "--notes-file",
  "--target",
  "--discussion-category",
  "--notes-start-tag",
]);
const RELEASE_BOOL_FLAGS = new Set([
  "-d",
  "--draft",
  "-p",
  "--prerelease",
  "--generate-notes",
  "--verify-tag",
  "--notes-from-tag",
  "--fail-on-no-commits",
  "--latest",
]);

/** A tag as `gh release create` takes it; anything else is not read as one. */
const TAG = /^[^\s-][^\s]{0,254}$/;

/**
 * The releases one command head creates: each `gh release create <tag>`, with
 * the repository its `-R`/`--repo` or `GH_REPO` names. The tag is read from
 * the command, so a release it created and then deleted still names its tag,
 * and GitHub's own read says there is no such release now.
 */
export function releaseRefsOfCommand(command: string): ReleaseRef[] {
  const refs: ReleaseRef[] = [];
  for (const { tokens } of commandsOf(command)) {
    const gh = ghArguments(tokens);
    if (gh === null) continue;
    const read = ghPositionals(
      gh.args,
      () => RELEASE_VALUE_FLAGS,
      () => RELEASE_BOOL_FLAGS,
      2,
    );
    if (read === null) continue;
    const [group, verb, tag] = read.positionals;
    if (group !== "release" || verb !== "create") continue;
    if (tag === undefined || !TAG.test(tag)) continue;
    const spelled = read.repository ?? gh.envRepository;
    const repository = repositoryOf(spelled);
    if (spelled !== null && repository === null) continue;
    refs.push({ repository, tag });
  }
  return refs;
}

/** The recorder's `issue.*` attrs on one frame (`issueAttrs`, tacho). */
export interface IssueAttrs {
  repository: string;
  number: string;
  url: string;
  action: string;
}

function isAction(value: string): value is RunIssueAction {
  return (RUN_ISSUE_ACTIONS as readonly string[]).includes(value);
}

/**
 * The issue the recorder named on a frame, or null when the frame carries no
 * readable number. The repository attr wins, and the URL fills what it leaves
 * out. An action outside the vocabulary reads as `mentioned`.
 */
export function issueRefOfAttrs(attrs: IssueAttrs): IssueRef | null {
  const fromUrl = attrs.url ? issueOfUrl(attrs.url) : null;
  const number = positiveInt(attrs.number) ?? fromUrl?.number ?? null;
  if (number === null) return null;
  const repository =
    repositoryOf(attrs.repository) ?? fromUrl?.repository ?? null;
  return {
    repository,
    number,
    action: isAction(attrs.action) ? attrs.action : "mentioned",
    url: fromUrl !== null && fromUrl.number === number ? fromUrl.url : null,
  };
}

/** One frame that may name an issue or a release. */
export interface CommandRefFrameRow {
  seq: number | string;
  /** `tool_target`: the command head for a shell frame. */
  command: string;
  /** The checkout the frame ran in, as `readWorkContexts` names it. */
  path: string;
  observed_at: string;
  issue_repository: string;
  issue_number: string;
  issue_url: string;
  issue_action: string;
  /** The recorder's `release.*` attrs on a GitHub MCP release call (`releaseAttrs`, tacho). */
  release_repository: string;
  release_tag: string;
}

/** The most frames one read returns; one more says the cap was hit. */
export const COMMAND_REF_FRAME_CAP = 2000;

// The same path expression `readWorkContexts` groups checkouts by, so a
// frame's path matches a checkout's exactly.
const PATH =
  "coalesce(nullIf(worktree_path, ''), nullIf(project_dir, ''), cwd)";

/**
 * The session's command and network effect frames that could name an issue
 * or a release, in frame order: a command head that contains "issue" or
 * "release", or a frame the recorder gave `issue.*` or `release.*` attrs. The parse is done
 * here, in code, so the query stays a plain filter. It reads every frame the
 * control plane accepted, whatever its chain verdict (ADR-171), and filters on
 * the same organization, workspace and session as every other work read.
 */
export async function readRunCommandRefFrames(
  sessionUuid: string,
): Promise<CommandRefFrameRow[]> {
  const result = await chSelect<CommandRefFrameRow>({
    query: `SELECT seq, tool_target AS command, ${PATH} AS path,
      toString(ts) AS observed_at,
      attrs['issue.repository'] AS issue_repository,
      attrs['issue.number'] AS issue_number,
      attrs['issue.url'] AS issue_url,
      attrs['issue.action'] AS issue_action,
      attrs['release.repository'] AS release_repository,
      attrs['release.tag'] AS release_tag
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID}
        AND kind IN ('command', 'network')
        AND (positionCaseInsensitive(tool_target, 'issue') > 0
          OR positionCaseInsensitive(tool_target, 'release') > 0
          OR attrs['issue.number'] != ''
          OR attrs['release.tag'] != '')
      ORDER BY seq ASC LIMIT {limit:UInt32}`,
    params: { sessionUuid, limit: COMMAND_REF_FRAME_CAP + 1 },
  });
  return result.data;
}

/** A release's repository and tag as one key; a null repository keys as none. */
function releaseKey(ref: ReleaseRef): string {
  const repository =
    ref.repository === null
      ? ""
      : `${ref.repository.owner}/${ref.repository.name}`.toLowerCase();
  return `${repository}@${ref.tag}`;
}

/**
 * One frame's releases: the one the recorder named on a GitHub MCP release
 * call (`release.*` attrs), then each `gh release create` in its command
 * head, each repository and tag once. One tag created in two repositories is
 * two releases, as `readWorkReleases` counts them.
 */
export function releaseRefsOfFrame(row: CommandRefFrameRow): ReleaseRef[] {
  const refs: ReleaseRef[] = [];
  const tag = row.release_tag;
  let attrTag: string | null = null;
  if (tag !== "" && TAG.test(tag)) {
    const repository = repositoryOf(row.release_repository);
    // An attr that names a repository this parser cannot read is not a
    // release with no repository.
    if (row.release_repository === "" || repository !== null) {
      refs.push({ repository, tag });
      attrTag = tag;
    }
  }
  for (const ref of releaseRefsOfCommand(row.command)) {
    // The attrs name the repository of the call a command without `-R`
    // made, so that command's tag is the attrs' release.
    if (ref.repository === null && ref.tag === attrTag) continue;
    if (!refs.some((seen) => releaseKey(seen) === releaseKey(ref)))
      refs.push(ref);
  }
  return refs;
}

/** A ClickHouse `DateTime64` rendered by `toString`, as RFC 3339; null when it does not parse. */
export function chInstant(ts: string): string | null {
  const parsed = new Date(`${ts.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function sameRepository(a: RunRepository, b: RunRepository): boolean {
  return a.url.toLowerCase() === b.url.toLowerCase();
}

/** The one repository in a list, or null when the list holds none or several. */
function onlyRepository(
  repositories: readonly (RunRepository | null)[],
): RunRepository | null {
  let only: RunRepository | null = null;
  for (const repository of repositories) {
    if (repository === null) continue;
    if (only === null) only = repository;
    else if (!sameRepository(only, repository)) return null;
  }
  return only;
}

/**
 * The repository a frame's issue or release belongs to, by ADR-197 rule 3,
 * from the record alone:
 *
 * 1. the repository the frame names (`-R`, `GH_REPO`, a URL, the recorder's
 *    attr), connected when the workspace holds a connection for it;
 * 2. otherwise the one repository recorded for the checkout at the frame's
 *    path;
 * 3. otherwise the run's only recorded repository.
 *
 * Null when none of these names exactly one, and the caller says the
 * repository is unknown rather than guessing.
 */
export function resolveFrameRepository(
  named: NamedRepository | null,
  path: string,
  checkouts: readonly RunCheckout[],
  repositories: readonly ConnectedRunRepository[],
): RunRepository | null {
  if (named !== null) {
    const connected = repositories.find(
      (repo) =>
        repo.host === "github.com" &&
        repo.owner.toLowerCase() === named.owner.toLowerCase() &&
        repo.name.toLowerCase() === named.name.toLowerCase(),
    );
    if (connected !== undefined)
      return {
        host: connected.host,
        owner: connected.owner,
        name: connected.name,
        url: connected.url,
        connected: true,
      };
    return {
      host: "github.com",
      owner: named.owner,
      name: named.name,
      url: `https://github.com/${named.owner}/${named.name}`,
      connected: false,
    };
  }
  const here = onlyRepository(
    checkouts
      .filter((checkout) => checkout.path === path)
      .map((checkout) => checkout.repository),
  );
  if (here !== null) return here;
  return onlyRepository(checkouts.map((checkout) => checkout.repository));
}

/** The connection a resolved repository is read through; undefined when it has none. */
export function connectionOf(
  repository: RunRepository,
  repositories: readonly ConnectedRunRepository[],
): ConnectedRunRepository | undefined {
  if (!repository.connected) return undefined;
  return repositories.find((repo) => sameRepository(repo, repository));
}

/**
 * One frame's issue refs: the recorder's attrs first, then the command's. A
 * bare number the command names is the attrs' issue when the numbers agree,
 * so it takes the attrs' repository rather than being resolved again. The
 * handler merges refs to one issue into one row.
 */
export function issueRefsOfFrame(row: CommandRefFrameRow): IssueRef[] {
  const fromAttrs = issueRefOfAttrs({
    repository: row.issue_repository,
    number: row.issue_number,
    url: row.issue_url,
    action: row.issue_action,
  });
  const refs: IssueRef[] = fromAttrs === null ? [] : [fromAttrs];
  for (const ref of issueRefsOfCommand(row.command)) {
    const same =
      fromAttrs !== null &&
      ref.number === fromAttrs.number &&
      (ref.repository === null || refKey(ref) === refKey(fromAttrs));
    refs.push(
      same
        ? { ...ref, repository: fromAttrs.repository, url: ref.url ?? fromAttrs.url }
        : ref,
    );
  }
  return refs;
}
