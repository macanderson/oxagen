/**
 * Does this shell command *run tests*?
 *
 * The question is positional: the runner has to be the program being executed,
 * not a word that appears somewhere on the line. That distinction is the whole
 * module, because everything downstream inherits whatever it admits — a
 * fail→pass transition on a command accepted here sets `flippedBy`, which makes
 * `hasWitnessClaim` true, which is what entitles the mutation gate to certify a
 * turn as test-witnessed.
 *
 * This used to be one unanchored regex, so it fired on a runner's name in an
 * argument, a path, a commit message or a search pattern. All eight of the
 * lines in `command-runs-tests.test.ts`'s table matched, and exactly one of
 * them runs a test (#1361).
 *
 * Both directions of that are wrong and neither is visible. A recursive search
 * for the word `pytest` exits 1 while nothing matches and 0 once the agent
 * writes a file containing it — a fail→pass flip on a command that ran no
 * tests, and the agent is credited with a witness for having created a file. In
 * the other direction, `planWitnessCommands` picks from currently-passing
 * test-like commands, so the gate could spend its witness budget re-running
 * that search, watch it pass with the fix reverted, and tell a correct fix that
 * its tests do not witness it.
 *
 * So a command is parsed rather than scanned:
 *
 * 1. Split on `&&`, `||`, `;` and `|`, so a `cd` prefix is not judged, and a
 *    pipe into `tee` is judged on the producer rather than on `tee`.
 * 2. Drop leading environment assignments and wrappers that execute another
 *    program (`sudo`, `env`, `time`, `nice`, `nohup`, `xvfb-run`, `npx`,
 *    `bunx`, and the `<tool> run` form used by `poetry`, `uv`, `pipenv`).
 * 3. Judge what is left by its argv-0, plus a subcommand where the runner needs
 *    one.
 *
 * Linters stay out by design (F2 spec): `eslint`, `ruff`, `tsc` and friends are
 * not test runners, and neither are plain builds or installs.
 */

/** Runners that are test runners by their own name, with no subcommand. */
const RUNNER_NAMES = new Set([
  "ava",
  "ctest",
  "jest",
  "karma",
  "mocha",
  "nose",
  "nose2",
  "phpunit",
  "py.test",
  "pytest",
  "rspec",
  "tap",
  "tox",
  "vitest",
]);

/**
 * Runners that take exactly one subcommand, in first position. Only that
 * position is consulted, so building a directory that happens to be named
 * `test` is not a test run.
 */
const SUBCOMMAND_RUNNERS = new Map<string, Set<string>>([
  ["cargo", new Set(["test", "nextest"])],
  ["dotnet", new Set(["test"])],
  ["go", new Set(["test"])],
]);

/**
 * Build tools that take a *list* of goals, where a test goal can sit anywhere
 * in the list — a clean-then-verify invocation runs tests, and so does a build
 * target followed by a test target.
 */
const GOAL_RUNNERS = new Map<string, Set<string>>([
  ["gradle", new Set(["test", "check"])],
  ["gradlew", new Set(["test", "check"])],
  ["make", new Set(["test", "check"])],
  ["mvn", new Set(["test", "verify"])],
  ["rake", new Set(["test", "spec"])],
]);

/** Node package managers, which reach a runner through a script or `exec`. */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/**
 * Package-manager subcommands that are definitely not a test run, so an
 * install naming a test framework as its dependency cannot become one.
 */
const NON_TEST_PM_SUBCOMMANDS = new Set([
  "add",
  "audit",
  "ci",
  "config",
  "create",
  "dedupe",
  "i",
  "init",
  "install",
  "link",
  "list",
  "ls",
  "outdated",
  "pack",
  "publish",
  "remove",
  "rm",
  "store",
  "uninstall",
  "unlink",
  "update",
  "why",
]);

/** Wrappers that run the command that follows them. */
const EXEC_WRAPPERS = new Set([
  "bunx",
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "npx",
  "stdbuf",
  "sudo",
  "time",
  "xvfb-run",
]);

/** Two-token wrappers: the tool, then a literal `run`, then the real command. */
const RUN_WRAPPERS = new Set([
  "conda",
  "hatch",
  "pdm",
  "pipenv",
  "poetry",
  "rye",
  "uv",
]);

/** Interpreters that make their script argument the program being run. */
const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "node",
  "bun",
]);

/** Flags that consume the token after them, so it is not the subcommand. */
const VALUE_FLAGS = new Set([
  "-C",
  "-F",
  "--dir",
  "--filter",
  "--prefix",
  "--workspace",
  "-w",
]);

/** Scratch scripts the harness itself writes are test-like by location. */
const SCRATCH_PREFIX = ".oxagen/scratch/";

/** A leading `NAME=value` assignment, which is not a program. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `python`, `python3`, `python3.12` — any of them can carry `-m`. */
const PYTHON = /^python[0-9.]*$/;

/** `test`, `test:unit`, `test-watch` — a script whose job is running tests. */
const TEST_SCRIPT_NAME = /^test([:\-].*)?$/;

/**
 * Split a command line into the programs it actually executes. Quoted regions
 * are skipped, so a separator inside a commit message does not open a segment.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < command.length; index++) {
    const char = command[index] as string;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      segments.push(current);
      current = "";
      index++;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((s) => s !== "");
}

/** Whitespace-split a segment into tokens, dropping surrounding quotes. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of segment) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/**
 * An absolute or relative path is still its runner, and the comparison is
 * case-insensitive because that is the contract this replaced (the old regex
 * carried the `i` flag, and a case-insensitive filesystem makes it true in
 * practice).
 */
function basename(token: string): string {
  const cut = token.lastIndexOf("/");
  return (cut === -1 ? token : token.slice(cut + 1)).toLowerCase();
}

/**
 * Strip leading environment assignments and exec wrappers so argv-0 is the
 * program that will actually run.
 */
function stripWrappers(tokens: string[]): string[] {
  let rest = tokens;
  // A wrapper can wrap a wrapper, so this walks; the bound stops a
  // pathological line from spinning.
  for (let guard = 0; guard < 12 && rest.length > 0; guard++) {
    const head = rest[0] as string;

    if (ENV_ASSIGNMENT.test(head)) {
      rest = rest.slice(1);
      continue;
    }

    const name = basename(head);
    if (EXEC_WRAPPERS.has(name)) {
      // A wrapper's own flags belong to the wrapper, not to the program it is
      // about to run, so they are dropped with it.
      rest = dropLeadingFlags(rest.slice(1));
      continue;
    }
    if (RUN_WRAPPERS.has(name) && rest[1] === "run") {
      rest = dropLeadingFlags(rest.slice(2));
      continue;
    }
    // `-m <module>` makes the module the program; a bare script argument does
    // not, which is what keeps an ordinary script invocation out.
    if (PYTHON.test(name) && rest[1] === "-m") {
      rest = rest.slice(2);
      continue;
    }
    return rest;
  }
  return rest;
}

/** Drop leading flag tokens (and the values the known ones consume). */
function dropLeadingFlags(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (VALUE_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

/** The first token that is not a flag, nor the value one of them consumes. */
function firstSubcommand(tokens: string[]): string | undefined {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (VALUE_FLAGS.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

/** Every non-flag token — the goal list a build tool was given. */
function everySubcommand(tokens: string[]): string[] {
  const goals: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (VALUE_FLAGS.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith("-")) continue;
    goals.push(token);
  }
  return goals;
}

function packageManagerRunsTests(rest: string[]): boolean {
  const args = rest.slice(1);
  const raw = firstSubcommand(args);
  if (raw === undefined) return false;
  const subcommand = raw.toLowerCase();
  if (NON_TEST_PM_SUBCOMMANDS.has(subcommand)) return false;

  if (TEST_SCRIPT_NAME.test(subcommand) || subcommand === "t") return true;

  const after = args.slice(args.indexOf(raw) + 1);

  if (subcommand === "run" || subcommand === "run-script") {
    const script = firstSubcommand(after);
    return script !== undefined && TEST_SCRIPT_NAME.test(script.toLowerCase());
  }

  if (subcommand === "exec" || subcommand === "dlx") {
    const target = firstSubcommand(after);
    return target !== undefined && RUNNER_NAMES.has(basename(target));
  }

  return RUNNER_NAMES.has(basename(subcommand));
}

function segmentRunsTests(segment: string): boolean {
  const rest = stripWrappers(tokenize(segment));
  const head = rest[0];
  if (head === undefined) return false;
  const name = basename(head);

  // A scratch script the harness wrote, run directly or through a shell. Note
  // this is argv-0, so reading such a file with a pager or `cat` is not a test
  // run — which the old path-substring arm got wrong.
  if (head.includes(SCRATCH_PREFIX)) return true;
  if (INTERPRETERS.has(name) || PYTHON.test(name)) {
    const script = rest[1];
    if (script !== undefined) {
      if (script.includes(SCRATCH_PREFIX)) return true;
      if (basename(script) === "runtests.py") return true;
    }
    // Falls through rather than returning: one name is both an interpreter and
    // a package manager, and its script form must not shadow its script-running
    // form.
  }

  if (name === "runtests.py") return true;
  if (RUNNER_NAMES.has(name)) return true;
  if (PACKAGE_MANAGERS.has(name)) return packageManagerRunsTests(rest);
  if (INTERPRETERS.has(name) || PYTHON.test(name)) return false;

  const subcommands = SUBCOMMAND_RUNNERS.get(name);
  if (subcommands !== undefined) {
    const subcommand = firstSubcommand(rest.slice(1));
    return (
      subcommand !== undefined && subcommands.has(subcommand.toLowerCase())
    );
  }

  const goals = GOAL_RUNNERS.get(name);
  if (goals !== undefined) {
    return everySubcommand(rest.slice(1)).some((goal) =>
      goals.has(goal.toLowerCase()),
    );
  }

  // `python -m unittest` arrives here as `unittest`, which is not an installed
  // program but is the module being run.
  if (name === "unittest") return true;

  return false;
}

/**
 * Returns true if the command runs tests — see the module comment for the
 * grammar, and for why this is a parse rather than a regex.
 */
export function isTestLikeCommand(command: string): boolean {
  return splitSegments(command).some(segmentRunsTests);
}
