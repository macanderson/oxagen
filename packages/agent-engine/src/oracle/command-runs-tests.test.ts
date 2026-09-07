/**
 * The eight-line table from #1361 is the centre of this file. Under the old
 * unanchored regex all eight matched; exactly one of them runs a test, and the
 * seven that do not are ordinary things an agent does while exploring a repo —
 * this needs no adversary to trip.
 */
import { describe, expect, it } from "vitest";
import { isTestLikeCommand } from "./command-runs-tests";

describe("a runner named in an argument is not a test run (#1361)", () => {
  const SEARCH = ["grep", "-rn", "pytest", "."].join(" ");

  it.each([
    [SEARCH, "a recursive search for the runner's name"],
    ["rg pytest src/", "the same search under a different tool"],
    ["git commit -m 'add vitest config'", "a commit message"],
    ["rm -rf node_modules/.cache/jest", "a cache path"],
    ["cat docs/how-to-run-pytest.md", "a document filename"],
    ["echo 'remember to run pytest'", "a reminder to a human"],
    ["ls packages/cargo test-fixtures", "a directory listing"],
  ])("%s is not a test command (%s)", (command) => {
    expect(isTestLikeCommand(command)).toBe(false);
  });

  it("pytest -x is the only line in the table that runs a test", () => {
    expect(isTestLikeCommand("pytest -x")).toBe(true);
  });

  it("reading a scratch script is not running it", () => {
    // The old path-substring arm made every mention of the scratch directory
    // test-like, including a plain read.
    expect(isTestLikeCommand("cat .oxagen/scratch/notes.txt")).toBe(false);
    expect(isTestLikeCommand("ls .oxagen/scratch/")).toBe(false);
    expect(isTestLikeCommand(".oxagen/scratch/repro.sh")).toBe(true);
    expect(isTestLikeCommand("bash .oxagen/scratch/repro.sh")).toBe(true);
  });

  it("does not turn an install into a test run by its dependency", () => {
    expect(isTestLikeCommand("npm install --save-dev jest")).toBe(false);
    expect(isTestLikeCommand("pnpm add -D vitest")).toBe(false);
    expect(isTestLikeCommand("pnpm remove mocha")).toBe(false);
  });

  it("judges a pipeline on the producer, not on what it pipes into", () => {
    expect(isTestLikeCommand("pytest -x | tee run.log")).toBe(true);
    expect(isTestLikeCommand("cat log | grep pytest")).toBe(false);
  });

  it("does not open a segment inside a quoted separator", () => {
    expect(isTestLikeCommand("git commit -m 'fix; run pytest later'")).toBe(
      false,
    );
  });
});

describe("the runners that must still be recognized", () => {
  it.each([
    "pytest",
    "pytest -x tests/",
    "py.test",
    "python -m pytest",
    "python3 -m pytest -q",
    "python3.12 -m unittest discover",
    "poetry run pytest",
    "uv run pytest -q",
    "pipenv run pytest",
    "tox",
    "nose2",
    "rspec spec/",
    "phpunit",
    "ctest",
  ])("%s", (command) => {
    expect(isTestLikeCommand(command)).toBe(true);
  });

  it.each([
    "vitest run",
    "jest --ci",
    "mocha",
    "npx vitest run",
    "npx jest",
    "pnpm exec vitest run",
    "yarn dlx jest",
  ])("%s", (command) => {
    expect(isTestLikeCommand(command)).toBe(true);
  });

  it.each([
    "npm test",
    "npm t",
    "npm run test",
    "npm run test:unit",
    "pnpm test",
    "pnpm run test",
    "pnpm --filter @oxagen/engram test",
    "pnpm -F @oxagen/engram test",
    "yarn test",
    "bun test",
  ])("%s", (command) => {
    expect(isTestLikeCommand(command)).toBe(true);
  });

  it.each([
    "go test ./...",
    "cargo test",
    "cargo nextest run",
    "dotnet test",
    "mvn -q test",
    "mvn clean verify",
    "./gradlew test",
    "rake test",
    "make test",
    "make check",
  ])("%s", (command) => {
    expect(isTestLikeCommand(command)).toBe(true);
  });

  it("looks through a cd prefix and through env wrappers", () => {
    expect(isTestLikeCommand("cd packages/engram && pytest")).toBe(true);
    expect(isTestLikeCommand("CI=1 pytest")).toBe(true);
    expect(isTestLikeCommand("env CI=1 NODE_ENV=test npx vitest run")).toBe(
      true,
    );
    expect(isTestLikeCommand("sudo -E time pytest")).toBe(true);
  });

  it("finds the runner in any segment, not only the first", () => {
    expect(isTestLikeCommand("pnpm install && pnpm test")).toBe(true);
    expect(isTestLikeCommand("pnpm build; pytest -q")).toBe(true);
  });

  it("resolves a runner given by path", () => {
    expect(isTestLikeCommand("/usr/local/bin/pytest -x")).toBe(true);
    expect(isTestLikeCommand("./node_modules/.bin/vitest run")).toBe(true);
  });
});

describe("what stays out by design", () => {
  it.each([
    "eslint .",
    "ruff check .",
    "tsc --noEmit",
    "pnpm lint",
    "pnpm run build",
    "npm ci",
    "make build",
    "go build ./...",
    "cargo build",
    "cargo clippy",
    "git status",
    "python manage.py migrate",
    "node scripts/seed.js",
  ])("%s is not a test command", (command) => {
    expect(isTestLikeCommand(command)).toBe(false);
  });

  it("is empty-safe", () => {
    expect(isTestLikeCommand("")).toBe(false);
    expect(isTestLikeCommand("   ")).toBe(false);
    expect(isTestLikeCommand("&& ;")).toBe(false);
  });
});
