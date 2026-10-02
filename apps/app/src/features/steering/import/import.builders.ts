// Test builders for the Markdown import: rows, policies, files, and whole
// parse answers shaped as parse_markdown_import returns them, so the kernel
// seam's output parse accepts them. Only tests import this module (INV-22).
import type {
  ImportFileResult,
  ImportMemory,
  ImportPolicy,
  ImportRecord,
  ParseOutput,
} from "./rows";

export function importRecord(over: Partial<ImportRecord> = {}): ImportRecord {
  return {
    file: "CLAUDE.md",
    line: 3,
    origin: "split",
    lineage: "acme.claude.no-push-to-main",
    label: "No push to main",
    statement: "Never push to main. Open a pull request.",
    kind: "constraint",
    kindReason: "It forbids an action.",
    force: "must",
    forceWords: "Never",
    effect: "forbid",
    tokens: 9,
    duplicate: null,
    conflict: null,
    action: "add",
    frontmatter: null,
    ...over,
  };
}

export function importPolicy(over: Partial<ImportPolicy> = {}): ImportPolicy {
  return {
    file: "no-force-push.md",
    path: "policy/no-force-push.cedar",
    text: '// No agent force-pushes to main.\n@id("git.no-force-push")\nforbid (principal, action == Action::"github__push", resource);\n',
    statements: [{ id: "git.no-force-push", line: 5, effect: "forbid" }],
    issues: [],
    duplicate: null,
    replaces: false,
    action: "add",
    ...over,
  };
}

export function importMemory(over: Partial<ImportMemory> = {}): ImportMemory {
  return {
    file: "notes.md",
    line: 2,
    label: "Staging resets nightly",
    statement: "The staging database resets every night.",
    kind: "memory",
    force: "info",
    duplicate: null,
    issue: null,
    action: "add",
    ...over,
  };
}

export function importFileResult(
  over: Partial<ImportFileResult> = {},
): ImportFileResult {
  return {
    filename: "CLAUDE.md",
    target: "records",
    detected: "records",
    reason: "The file holds prose, so its statements become records.",
    records: 1,
    policies: 0,
    memories: 0,
    error: null,
    ...over,
  };
}

export function parseOutput(over: Partial<ParseOutput> = {}): ParseOutput {
  const records = over.records ?? [importRecord()];
  const policies = over.policies ?? [];
  const memories = over.memories ?? [];
  return {
    files: [importFileResult({ records: records.length })],
    records,
    policies,
    memories,
    pullRequestFiles: {
      count:
        records.filter((r) => r.action === "add").length +
        policies.filter((p) => p.action === "add").length,
      max: 299,
      message: null,
    },
    ...over,
  };
}
