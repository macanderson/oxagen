// markdown-import/cedar.ts: a Markdown file's Cedar policies (discussions
// spec, Markdown import: Detection, Policies, and Early checks).
//
// - A fenced `cedar` block holds policies. A block fenced in another
//   language, such as `text` or `js`, is an example and makes no policy.
// - A file with no `cedar` block but a top-level `permit(` or `forbid(` holds
//   policies there.
// - Each statement keeps its own @id. A statement with none takes the file's
//   slug, and the second and third without one take -2 and -3.
// - The prose above a block becomes the policy's leading comment.
// - The early checks read each statement's shape. They are not the Cedar
//   parser: the steering PR still runs the full checks.
import { policyFilePath } from "@oxagen/oxagen/steering-repo/paths";

/** One fenced or top-level region of Cedar text in a Markdown file. */
export interface CedarBlock {
  /** The 1-based line of the file the block's first line of Cedar is on. */
  line: number;
  /** The Cedar text. */
  text: string;
  /** The prose lines above the block, back to the previous block or the top of the file. */
  prose: string[];
}

/** One fence in a Markdown file. */
interface Fence {
  /** The 0-based line index of the opening fence. */
  open: number;
  /** The 0-based line index of the closing fence, or the line count when it never closes. */
  close: number;
  /** The info string's first word, lowercased. */
  language: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

/** Every fenced code block in the file, in order. */
function fences(lines: readonly string[]): Fence[] {
  const found: Fence[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i] as string);
    if (!open) continue;
    const marker = open[1] as string;
    const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let close = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (closing.test(lines[j] as string)) {
        close = j;
        break;
      }
    }
    found.push({ open: i, close, language: (open[2] ?? "").toLowerCase() });
    i = close;
  }
  return found;
}

const TOP_LEVEL_STATEMENT = /^\s*(?:permit|forbid)\s*\(/;
const STATEMENT_START = /^\s*(?:@[A-Za-z_]|permit\s*\(|forbid\s*\()/;

/** Lines outside every fence, by index. */
function unfenced(lines: readonly string[], found: readonly Fence[]): boolean[] {
  const outside = lines.map(() => true);
  for (const fence of found) {
    const last = Math.min(fence.close, lines.length - 1);
    for (let i = fence.open; i <= last; i += 1) outside[i] = false;
  }
  return outside;
}

/** True when the file holds a fenced `cedar` block or a top-level `permit(` or `forbid(` statement. */
export function hasCedar(content: string): boolean {
  const lines = content.split("\n");
  const found = fences(lines);
  if (found.some((fence) => fence.language === "cedar")) return true;
  const outside = unfenced(lines, found);
  return lines.some((line, i) => outside[i] && TOP_LEVEL_STATEMENT.test(line));
}

/** A heading's text without its markers, or the line as it is. */
function proseLine(line: string): string {
  return line.replace(/^\s{0,3}#{1,6}\s+/, "").trimEnd();
}

/** The prose between two line indexes, without leading and trailing blank lines. */
function proseBetween(lines: readonly string[], from: number, to: number): string[] {
  const kept = lines.slice(from, to).map(proseLine);
  while (kept.length > 0 && (kept[0] as string).trim() === "") kept.shift();
  while (kept.length > 0 && (kept[kept.length - 1] as string).trim() === "") kept.pop();
  return kept;
}

/**
 * The file's Cedar blocks: each fenced `cedar` block, or, when there is none,
 * the top-level statements from the first one to the last semicolon.
 */
export function cedarBlocks(content: string): CedarBlock[] {
  const lines = content.split("\n");
  const found = fences(lines);
  const cedar = found.filter((fence) => fence.language === "cedar");
  if (cedar.length > 0) {
    const blocks: CedarBlock[] = [];
    let after = 0;
    for (const fence of cedar) {
      blocks.push({
        line: fence.open + 2,
        text: lines.slice(fence.open + 1, fence.close).join("\n"),
        prose: proseBetween(lines, after, fence.open),
      });
      after = fence.close + 1;
    }
    return blocks;
  }
  const outside = unfenced(lines, found);
  const start = lines.findIndex((line, i) => outside[i] && STATEMENT_START.test(line));
  if (start < 0) return [];
  let end = start;
  for (let i = start; i < lines.length; i += 1) {
    if (outside[i] && (lines[i] as string).includes(";")) end = i;
  }
  const text = lines
    .slice(start, end + 1)
    .map((line, offset) => (outside[start + offset] ? line : ""))
    .join("\n");
  return [{ line: start + 1, text, prose: proseBetween(lines, 0, start) }];
}

// ── Statements ───────────────────────────────────────────────────────────────

/** One statement of a block, cut at its top-level semicolon. */
interface RawStatement {
  /** The `//` comment lines above the statement's code. */
  leading: string[];
  /** The statement's text, without its semicolon. */
  text: string;
  /** The 0-based offset in the block where the statement's code starts. */
  start: number;
  /** True when a semicolon ends the statement. */
  terminated: boolean;
}

/**
 * The text with `//` comments blanked to spaces, and string literals too
 * unless `keepStrings` is set. The answer has the same length as the text.
 */
function codeOnly(text: string, keepStrings = false): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') {
      out += keepStrings ? char : " ";
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          out += keepStrings ? text.slice(i, i + 2) : "  ";
          i += 2;
          continue;
        }
        out += keepStrings || text[i] === "\n" ? (text[i] as string) : " ";
        i += 1;
      }
      if (i < text.length) {
        out += keepStrings ? '"' : " ";
        i += 1;
      }
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** The block's statements, cut at each semicolon outside brackets, strings, and comments. */
function rawStatements(block: string): RawStatement[] {
  const code = codeOnly(block);
  const statements: RawStatement[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i];
    if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") depth -= 1;
    else if (char === ";" && depth <= 0) {
      statements.push({ leading: [], text: block.slice(from, i), start: from, terminated: true });
      from = i + 1;
      depth = 0;
    }
  }
  if (code.slice(from).trim() !== "") {
    statements.push({ leading: [], text: block.slice(from), start: from, terminated: false });
  }
  return statements
    .map((statement) => {
      const lead = codeOnly(statement.text).search(/\S/);
      if (lead < 0) return null;
      const leading = statement.text
        .slice(0, lead)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("//"));
      return {
        ...statement,
        leading,
        text: statement.text.slice(lead),
        start: statement.start + lead,
      };
    })
    .filter((statement): statement is RawStatement => statement !== null);
}

/** The index just past the bracket that closes the one at `open`, or -1. */
function closingBracket(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < code.length; i += 1) {
    const char = code[i] as string;
    if (pairs[char]) stack.push(pairs[char] as string);
    else if (char === ")" || char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** One annotation at the head of a statement. */
interface Annotation {
  name: string;
  /** The value in `@name("value")`, or null for a bare `@name`. */
  value: string | null;
}

const ANNOTATION = /^@([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\))?/;

/** What the early checks read from one statement. */
export interface ReadStatement {
  /** The statement's number in its file, from 1. */
  number: number;
  /** The `//` comment lines above it, kept in the policy file. */
  leading: string[];
  /** The 1-based line of the file the statement starts on. */
  line: number;
  annotations: Annotation[];
  /** The @id it carries, or null. */
  id: string | null;
  effect: "permit" | "forbid" | null;
  /** The statement's text from its effect on, with its semicolon. */
  body: string;
  /** The first problem the early checks found, or null. */
  problem: string | null;
}

/** The statement's label in a message: "Statement 2 (staging.deploys)", or "Statement 2". */
function named(number: number, id: string | null): string {
  return id ? `Statement ${number} (${id})` : `Statement ${number}`;
}

/** Read one statement's annotations, effect, scope, and conditions. */
function readStatement(raw: RawStatement, number: number, line: number): ReadStatement {
  let text = raw.text;
  const annotations: Annotation[] = [];
  let problem: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    // Skip whitespace and `//` comments between annotations.
    const lead = codeOnly(text).search(/\S/);
    text = lead < 0 ? "" : text.slice(lead);
    const match = ANNOTATION.exec(text);
    if (!match) break;
    const name = match[1] as string;
    const value = match[2] ?? null;
    if (seen.has(name) && problem === null) {
      problem = `has @${name} twice. Each annotation names itself once.`;
    }
    seen.add(name);
    annotations.push({ name, value });
    text = text.slice(match[0].length);
  }
  const idAnnotation = annotations.find((a) => a.name === "id") ?? null;
  const id = idAnnotation?.value ? idAnnotation.value : null;
  if (idAnnotation && !idAnnotation.value && problem === null) {
    problem = "has an @id with no value. Give it a name, such as @id(\"no-branch-delete\").";
  }
  const code = codeOnly(text);
  const effectMatch = /^(permit|forbid)\b/.exec(code);
  const body = `${text.trimEnd()};`;
  if (!effectMatch) {
    const word = /^\S+/.exec(code)?.[0] ?? "nothing";
    return {
      number,
      leading: raw.leading,
      line,
      annotations,
      id,
      effect: null,
      body,
      problem: problem ?? `has ${word.replace(/\(.*$/, "")} where permit or forbid belongs.`,
    };
  }
  const effect = effectMatch[1] as "permit" | "forbid";
  let at = effectMatch[0].length;
  while (/\s/.test(code[at] ?? "")) at += 1;
  if (code[at] !== "(") {
    problem ??= `has no scope after ${effect}. Write ${effect} (principal, action, resource).`;
  } else {
    const end = closingBracket(code, at);
    if (end < 0) {
      problem ??= "has a scope whose parenthesis does not close.";
    } else {
      const scope = code.slice(at + 1, end - 1);
      const order = ["principal", "action", "resource"].map((word) =>
        scope.search(new RegExp(`\\b${word}\\b`)),
      );
      const [principal = -1, action = -1, resource = -1] = order;
      if (principal < 0 || action < 0 || resource < 0 || !(principal < action && action < resource)) {
        problem ??= "has a scope that does not name principal, action, and resource, in that order.";
      }
      at = end;
      for (;;) {
        while (/\s/.test(code[at] ?? "")) at += 1;
        if (at >= code.length) break;
        const condition = /^(when|unless)\b/.exec(code.slice(at));
        if (!condition) {
          const word = /^\S+/.exec(code.slice(at))?.[0] ?? "";
          problem ??= `has ${word} where when, unless, or the closing semicolon belongs.`;
          break;
        }
        at += condition[0].length;
        while (/\s/.test(code[at] ?? "")) at += 1;
        if (code[at] !== "{") {
          problem ??= `has a ${condition[1]} clause with no braces.`;
          break;
        }
        const close = closingBracket(code, at);
        if (close < 0) {
          problem ??= `has a ${condition[1]} clause whose brackets do not close.`;
          break;
        }
        at = close;
      }
    }
  }
  if (!raw.terminated) problem ??= "has no semicolon at its end.";
  return {
    number,
    leading: raw.leading,
    line,
    annotations,
    id,
    effect,
    body,
    problem: problem ?? null,
  };
}

/** The 1-based file line of a block's offset. */
function lineAt(block: CedarBlock, offset: number): number {
  return block.line + (block.text.slice(0, offset).match(/\n/g)?.length ?? 0);
}

// ── The policy file ──────────────────────────────────────────────────────────

/** A problem the early checks found. */
export interface PolicyIssue {
  statement: number | null;
  id: string | null;
  line: number | null;
  message: string;
}

/** The Cedar policy file one Markdown file becomes. */
export interface PolicyFile {
  path: string;
  text: string;
  statements: { id: string; line: number; effect: "permit" | "forbid" }[];
  issues: PolicyIssue[];
}

/** A published policy file: where it is, and its text. */
export interface PublishedPolicy {
  path: string;
  text: string;
}

const ID_IN_TEXT = /@id\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;

/** Every @id a published policy file names. */
export function policyIds(text: string): string[] {
  return [...text.matchAll(ID_IN_TEXT)].map((match) => match[1] as string);
}

/**
 * A policy file's statements with comments and whitespace dropped, for a
 * duplicate test. String literals stay, so two policies on different actions
 * never read as one.
 */
export function normalizedPolicy(text: string): string {
  return codeOnly(text, true).replace(/\s+/g, "");
}

/** The leading comment a block's prose becomes. */
function comment(prose: readonly string[]): string[] {
  return prose.map((line) => (line.trim() === "" ? "//" : `// ${line.trim()}`));
}

/**
 * The policy file a Markdown file's Cedar becomes, at policy/<slug>.cedar.
 * `taken` holds the @ids other policy files already use. A statement with no
 * @id takes the slug, then slug-2, slug-3, skipping any id already taken.
 */
export function policyFile(args: {
  content: string;
  slug: string;
  taken: ReadonlyMap<string, string>;
}): PolicyFile {
  const blocks = cedarBlocks(args.content);
  const issues: PolicyIssue[] = [];
  if (blocks.length === 0) {
    issues.push({
      statement: null,
      id: null,
      line: null,
      message: "The file holds no cedar block and no top-level permit or forbid statement. Import it as a record instead.",
    });
  }
  const read: { block: CedarBlock; statements: ReadStatement[] }[] = [];
  let number = 0;
  for (const block of blocks) {
    const statements = rawStatements(block.text).map((raw) => {
      number += 1;
      return readStatement(raw, number, lineAt(block, raw.start));
    });
    if (statements.length === 0) {
      issues.push({
        statement: null,
        id: null,
        line: block.line,
        message: `The cedar block on line ${block.line} holds no statement.`,
      });
    }
    read.push({ block, statements });
  }

  // Ids: each statement keeps its own, and the rest take the slug in turn.
  const used = new Map<string, string>(args.taken);
  for (const { statements } of read) {
    for (const statement of statements) {
      if (statement.id === null) continue;
      const holder = used.get(statement.id);
      if (holder !== undefined && statement.problem === null) {
        statement.problem = `has @id ${statement.id}, which ${holder} already uses.`;
      }
      used.set(statement.id, `statement ${statement.number}`);
    }
  }
  let unnamed = 0;
  const assigned = new Map<ReadStatement, string>();
  for (const { statements } of read) {
    for (const statement of statements) {
      if (statement.id !== null) continue;
      let id: string;
      do {
        unnamed += 1;
        id = unnamed === 1 ? args.slug : `${args.slug}-${unnamed}`;
      } while (used.has(id));
      used.set(id, `statement ${statement.number}`);
      assigned.set(statement, id);
    }
  }

  const parts: string[] = [];
  const statements: PolicyFile["statements"] = [];
  for (const { block, statements: inBlock } of read) {
    const lines = comment(block.prose);
    for (const statement of inBlock) {
      const id = statement.id ?? (assigned.get(statement) as string);
      if (statement.problem !== null) {
        issues.push({
          statement: statement.number,
          id,
          line: statement.line,
          message: `${named(statement.number, statement.id)} ${statement.problem}`,
        });
      }
      if (statement.effect !== null) {
        statements.push({ id, line: statement.line, effect: statement.effect });
      }
      const annotations = statement.annotations
        .filter((a) => a.name !== "id")
        .map((a) => (a.value === null ? `@${a.name}` : `@${a.name}("${a.value}")`));
      lines.push(...statement.leading, `@id("${id}")`, ...annotations, statement.body);
    }
    parts.push(lines.join("\n"));
  }
  return {
    path: policyFilePath(args.slug),
    text: `${parts.join("\n\n")}\n`,
    statements,
    issues,
  };
}
