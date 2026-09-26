// fixture-repo.ts: reads the fixture steering repo in
// packages/oxagen/fixtures/steering-repo, for tests in any package.
//
//   repo/       a-intel/oxagen-core-platform, a workspace's steering repo
//               with one valid file of every type
//   org-repo/   a-intel/oxagen, the organization's repository
//   invalid/    one case per rule a check enforces: a case.json and the
//               files the case adds to or changes in repo/
//   stored/     what Oxagen stores and never commits: reflections, a bundle
//   v0.1/       today's .oxagen/ layout, and its conversion to v1
//   context.json  what Oxagen knows outside the repository, such as the
//               enrolled runtimes, for the references check
//
// It reads the file system, so it stays out of the steering-repo barrel.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The fixture folder, as an absolute path. */
export const FIXTURE_ROOT = fileURLToPath(
  new URL("../../fixtures/steering-repo", import.meta.url),
);

/** Every file under `dir`, keyed by its path relative to `dir` with `/` separators. */
export function readFixtureTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(dir, path).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  };
  walk(dir);
  return files;
}

/** The workspace steering repo, a-intel/oxagen-core-platform. */
export function fixtureRepo(): Map<string, string> {
  return readFixtureTree(join(FIXTURE_ROOT, "repo"));
}

/** The organization repository, a-intel/oxagen. */
export function organizationFixtureRepo(): Map<string, string> {
  return readFixtureTree(join(FIXTURE_ROOT, "org-repo"));
}

/** What Oxagen knows outside the repository, which the references check resolves against. */
export const fixtureContextSchema = z
  .object({
    note: z.string(),
    runtimes: z.array(z.string()),
    members: z.array(z.string()),
    teams: z.array(z.string()),
    groups: z.array(z.string()),
    credentials: z.array(z.string()),
  })
  .strict();
export type FixtureContext = z.output<typeof fixtureContextSchema>;

export function fixtureContext(): FixtureContext {
  return fixtureContextSchema.parse(
    JSON.parse(readFileSync(join(FIXTURE_ROOT, "context.json"), "utf8")),
  );
}

/** The checks a steering PR runs (steering-repo-spec, Steering PR flow). */
export const FIXTURE_CHECKS = [
  "schema",
  "lineage",
  "hash",
  "secrets",
  "conflicts",
  "authority",
  "settings",
  "references",
  "budget",
  "compile",
  "owned",
] as const;

/** One invalid case's case.json. */
export const invalidCaseSchema = z
  .object({
    check: z.enum(FIXTURE_CHECKS),
    rule: z.string().min(1),
    severity: z.enum(["error", "warning"]),
    description: z.string().min(1),
    /** True when this module's readers refuse the changed file on their own. */
    refused_by_reader: z.boolean(),
    changed: z.array(z.string()),
    removed: z.array(z.string()),
    /** Where the finding points: a path, and a line and field when the finding has one. */
    expect: z
      .array(
        z
          .object({
            path: z.string(),
            line: z.number().int().positive().optional(),
            field: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    /** For a settings case: what the host reports instead of the baseline. */
    actual_settings: z
      .object({
        provider: z.enum(["github", "gitlab"]),
        settings: z.unknown(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** An invalid case, with the repository it describes: repo/ with the case's changes. */
export type InvalidCase = z.output<typeof invalidCaseSchema> & {
  /** `<check>/<case>`, the case's folder under invalid/. */
  id: string;
  files: Map<string, string>;
};

/** Every invalid case, in folder order. */
export function invalidCases(): InvalidCase[] {
  const root = join(FIXTURE_ROOT, "invalid");
  const cases: InvalidCase[] = [];
  for (const check of readdirSync(root).sort()) {
    for (const name of readdirSync(join(root, check)).sort()) {
      const dir = join(root, check, name);
      const manifest = invalidCaseSchema.parse(
        JSON.parse(readFileSync(join(dir, "case.json"), "utf8")),
      );
      const files = fixtureRepo();
      for (const path of manifest.removed) files.delete(path);
      for (const path of manifest.changed) {
        files.set(path, readFileSync(join(dir, "repo", path), "utf8"));
      }
      cases.push({ ...manifest, id: `${check}/${name}`, files });
    }
  }
  return cases;
}
