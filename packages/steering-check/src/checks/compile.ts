// compile.ts: what Oxagen must be able to compile when the steering PR
// merges. Every tool tools.toml imports is in the server's lock or in its
// OpenAPI document, and every Cedar policy parses, validates against the
// schema, and passes its tests. The caller passes the Cedar evaluator in;
// without it, the Cedar rules do not run.
import {
  CEDAR_SCHEMA_PATH,
  classifySteeringRepoPath,
  TOOL_SERVERS_DIR,
  TOOLS_LOCK_NAME,
  TOOLS_TOML_NAME,
} from "@oxagen/oxagen/steering-repo";
import { finder, sentence, type TreeCheck } from "../finding";
import { isString, serverFolders, tomlLine } from "../repo";
import type { CedarHooks, Finding, SteeringTree } from "../types";

const find = finder("compile");

/** The OpenAPI documents a server folder may hold. */
const OPENAPI_NAMES = ["openapi.yaml", "openapi.json"] as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when an OpenAPI document names this operationId. */
export function hasOperation(document: string, operation: string): boolean {
  const name = escapeRegExp(operation);
  const yaml = new RegExp(`^\\s*operationId:\\s*["']?${name}["']?\\s*$`, "m");
  const json = new RegExp(`"operationId"\\s*:\\s*"${name}"`);
  return yaml.test(document) || json.test(document);
}

function lockFindings(tree: SteeringTree): Finding[] {
  const findings: Finding[] = [];
  for (const [name, folder] of serverFolders(tree)) {
    const dir = `${TOOL_SERVERS_DIR}/${name}`;
    const toolsPath = `${dir}/${TOOLS_TOML_NAME}`;
    const text = tree.get(toolsPath);
    const hasLock = tree.has(`${dir}/${TOOLS_LOCK_NAME}`);
    const documents = OPENAPI_NAMES.map((file) => tree.get(`${dir}/${file}`)).filter(isString);
    // A server Oxagen has not imported yet has neither, and its first import writes the lock.
    if (text === undefined || (!hasLock && documents.length === 0)) continue;
    for (const [key, entry] of folder.tools) {
      if (folder.locked.has(key)) continue;
      const operation = isString(entry.operation) ? entry.operation : null;
      if (operation !== null && documents.some((document) => hasOperation(document, operation))) continue;
      const source = documents.length > 0 ? "the lock or the OpenAPI document" : "the lock";
      findings.push(
        find({
          rule: "lock-matches",
          path: toolsPath,
          line: tomlLine(text, `tools.${key}`),
          field: `tools.${key}`,
          message:
            operation === null
              ? `tools.toml imports ${name}__${key}, and ${source} does not hold it.`
              : `tools.toml imports ${name}__${key} as operation ${operation}, and ${source} does not hold it.`,
          expected: `Every tool under [tools] in ${toolsPath} is in ${dir}/${TOOLS_LOCK_NAME}, or its operation is in the server's OpenAPI document.`,
          fix: `Remove [tools.${key}], or correct its name or operation to one the server offers. Oxagen adds a new upstream tool to the lock when it syncs the server.`,
        }),
      );
    }
  }
  return findings;
}

/** The tree's Cedar files: policies, tests, and the schema. */
export function cedarFiles(tree: SteeringTree): {
  policies: Map<string, string>;
  tests: Map<string, string>;
  schema: string;
} {
  const policies = new Map<string, string>();
  const tests = new Map<string, string>();
  for (const [path, text] of [...tree].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const kind = classifySteeringRepoPath(path);
    if (kind === "policy") policies.set(path, text);
    if (kind === "policy-tests") tests.set(path, text);
  }
  return { policies, tests, schema: tree.get(CEDAR_SCHEMA_PATH) ?? "" };
}

function cedarFindings(tree: SteeringTree, cedar: CedarHooks): Finding[] {
  const { policies, tests, schema } = cedarFiles(tree);
  const findings: Finding[] = [];
  const parsed = new Map<string, string>();
  for (const [path, text] of policies) {
    const issues = cedar.parse(path, text);
    if (issues.length === 0) parsed.set(path, text);
    for (const issue of issues) {
      findings.push(
        find({
          rule: "policy-parses",
          path,
          line: issue.line,
          field: null,
          message: `The policy does not parse: ${issue.message}`,
          expected: "A Cedar policy file that parses: each policy has an effect, a scope, and a closing semicolon.",
          fix: "Correct the syntax at this line. Every brace and parenthesis closes, and every policy ends with a semicolon.",
        }),
      );
    }
  }
  for (const issue of cedar.validate(parsed, schema)) {
    findings.push(
      find({
        rule: "policy-validates",
        path: issue.path,
        line: issue.line,
        field: null,
        message: sentence(issue.message),
        expected: `Every action, entity, and attribute the policy names is in ${CEDAR_SCHEMA_PATH}.`,
        fix: `Name an action ${CEDAR_SCHEMA_PATH} declares. Oxagen declares one action for each imported tool, so import the tool first if it is new.`,
      }),
    );
  }
  // A test of a policy that does not parse reports that policy's error, not a second one.
  if (parsed.size !== policies.size) return findings;
  for (const issue of cedar.test(parsed, schema, tests)) {
    findings.push(
      find({
        rule: "policy-test-passes",
        path: issue.path,
        line: issue.line,
        field: null,
        message: sentence(issue.message),
        expected: "Every policy test gets the decision it expects.",
        fix: "Correct the policy if the test states what you want. Otherwise correct the test's expect.",
      }),
    );
  }
  return findings;
}

export const compileCheck: TreeCheck = (tree, env) => {
  const findings = lockFindings(tree);
  if (env.cedar) findings.push(...cedarFindings(tree, env.cedar));
  return findings;
};
