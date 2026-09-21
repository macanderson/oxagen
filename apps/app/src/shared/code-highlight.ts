// Syntax tokens for the languages a transcript shows: the shell commands an
// agent ran, and the JSON a tool was handed or returned.
//
// It shares its token kinds with `toml-highlight.ts`, because the house has
// exactly one set of code colours (`--code-*` in `apps/app/src/app/globals.css`)
// and a transcript that invented a seventh would be the only surface in the
// product with a colour nothing else uses. A scanner here colours; it never
// judges, never throws and never drops a character: every byte of the source
// lands in exactly one token, in order, and text it cannot read is a `text`
// token. Pure and edge-safe, so a malformed command still paints.

/**
 * The house code colours, named for what TOML made them and reused for what
 * they mean in every other language:
 *
 * | kind      | TOML          | shell                  | JSON        |
 * |-----------|---------------|------------------------|-------------|
 * | `table`   | table header  | the command word        | —           |
 * | `key`     | a bare key    | a variable or a flag    | an object key |
 * | `string`  | a string      | a quoted word           | a string    |
 * | `number`  | a number      | a number, `true`/`false`| a number, a literal |
 * | `punct`   | punctuation   | an operator, a redirect | punctuation |
 * | `comment` | a comment     | a comment               | —           |
 */
export type CodeTokenKind =
  | "comment"
  | "table"
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "punct"
  | "text";

export type CodeToken = { kind: CodeTokenKind; text: string };

/** The languages the transcript paints. `text` paints nothing and is the fallback. */
export type CodeLanguage = "shell" | "json" | "text";

/** Sticky, so a match reads at the cursor without slicing the source. */
const SHELL_COMMENT = /#[^\n]*/y;
const SHELL_SINGLE = /'(?:[^'\\]|\\[\s\S])*'?/y;
const SHELL_DOUBLE = /"(?:[^"\\]|\\[\s\S])*"?/y;
const SHELL_VARIABLE = /\$(?:\{[^}\n]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9?@*#$!-])/y;
const SHELL_FLAG = /--?[A-Za-z0-9][A-Za-z0-9_-]*/y;
/** Not sticky: it tests a word already read, not the source at a cursor. */
const SHELL_NUMBER = /^\d+(?:\.\d+)?$/;
const SHELL_WORD = /[A-Za-z0-9_./~@:+=%^,[\]{}-]+/y;
const SHELL_OPERATOR = /(?:&&|\|\||>>|<<<|<<|[|;&<>()])/y;
const SHELL_SPACE = /[ \t\r\n]+/y;

/**
 * Words that open a command position even though a command word already
 * stands before them, so `sudo git status` paints `git` as the command and
 * `cd x && ls` paints both. Keeping the list short is deliberate: a word this
 * does not know is painted as an argument, which is the honest default.
 */
const COMMAND_PREFIX: ReadonlySet<string> = new Set([
  "sudo",
  "command",
  "env",
  "nohup",
  "time",
  "xargs",
  "exec",
  "then",
  "else",
  "do",
  "!",
]);

/** After one of these, the next word is a command again. */
const RESETS: ReadonlySet<string> = new Set([
  "|",
  "||",
  "&&",
  ";",
  "&",
  "(",
  "\n",
]);

function read(src: string, at: number, re: RegExp): string | null {
  re.lastIndex = at;
  const m = re.exec(src);
  return m === null ? null : m[0];
}

/**
 * A shell command as coloured tokens.
 *
 * The command word is the one thing a reader looks for first, so it takes the
 * accent and everything after it is an argument. "Command position" resets
 * after a pipe, a `&&`, a `;` and a newline, so every command in a chain is
 * found, not just the first.
 */
export function tokenizeShell(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let pos = 0;
  // True while the next bare word would be the command rather than an argument.
  let atCommand = true;
  const push = (kind: CodeTokenKind, text: string) => {
    tokens.push({ kind, text });
    pos += text.length;
  };
  while (pos < source.length) {
    const space = read(source, pos, SHELL_SPACE);
    if (space !== null) {
      if (space.includes("\n")) atCommand = true;
      push("text", space);
      continue;
    }
    const comment = read(source, pos, SHELL_COMMENT);
    if (comment !== null) {
      push("comment", comment);
      continue;
    }
    const operator = read(source, pos, SHELL_OPERATOR);
    if (operator !== null) {
      if (RESETS.has(operator)) atCommand = true;
      push("punct", operator);
      continue;
    }
    const single = read(source, pos, SHELL_SINGLE);
    if (single !== null) {
      atCommand = false;
      push("string", single);
      continue;
    }
    const double = read(source, pos, SHELL_DOUBLE);
    if (double !== null) {
      atCommand = false;
      push("string", double);
      continue;
    }
    const variable = read(source, pos, SHELL_VARIABLE);
    if (variable !== null) {
      atCommand = false;
      push("key", variable);
      continue;
    }
    const flag = read(source, pos, SHELL_FLAG);
    if (flag !== null) {
      atCommand = false;
      push("key", flag);
      continue;
    }
    const word = read(source, pos, SHELL_WORD);
    if (word !== null) {
      if (atCommand) {
        push("table", word);
        // `sudo`, `env` and friends stand before the real command, so the
        // next word is still a command word.
        atCommand = COMMAND_PREFIX.has(word);
        continue;
      }
      push(SHELL_NUMBER.test(word) ? "number" : "text", word);
      continue;
    }
    // A byte no rule claimed. Emitting it as `text` is what keeps the
    // invariant that the tokens rebuild the source exactly.
    push("text", source[pos] ?? "");
  }
  return tokens;
}

const JSON_STRING = /"(?:[^"\\]|\\[\s\S])*"?/y;
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/y;
const JSON_LITERAL = /(?:true|false|null)\b/y;
const JSON_SPACE = /[ \t\r\n]+/y;
const JSON_PUNCT = /[{}[\],:]/y;

/** JSON as coloured tokens. A string before a `:` is a key, not a value. */
export function tokenizeJson(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let pos = 0;
  const push = (kind: CodeTokenKind, text: string) => {
    tokens.push({ kind, text });
    pos += text.length;
  };
  while (pos < source.length) {
    const space = read(source, pos, JSON_SPACE);
    if (space !== null) {
      push("text", space);
      continue;
    }
    const str = read(source, pos, JSON_STRING);
    if (str !== null) {
      // Look past the whitespace: a `:` next makes this a key.
      const after = pos + str.length;
      const gap = read(source, after, JSON_SPACE) ?? "";
      push(source[after + gap.length] === ":" ? "key" : "string", str);
      continue;
    }
    const literal = read(source, pos, JSON_LITERAL);
    if (literal !== null) {
      push("number", literal);
      continue;
    }
    const num = read(source, pos, JSON_NUMBER);
    if (num !== null) {
      push("number", num);
      continue;
    }
    const punct = read(source, pos, JSON_PUNCT);
    if (punct !== null) {
      push("punct", punct);
      continue;
    }
    push("text", source[pos] ?? "");
  }
  return tokens;
}

const SCANNERS: Record<CodeLanguage, (source: string) => CodeToken[]> = {
  shell: tokenizeShell,
  json: tokenizeJson,
  text: (source) => (source === "" ? [] : [{ kind: "text", text: source }]),
};

export function tokenizeCode(
  source: string,
  language: CodeLanguage,
): CodeToken[] {
  return SCANNERS[language](source);
}

/**
 * The language a file's contents are painted in, from its path.
 *
 * Deliberately coarse: the transcript paints shell and JSON, and everything
 * else is honest plain text rather than a half-right guess with a
 * TypeScript scanner that does not exist here.
 */
export function languageForPath(path: string): CodeLanguage {
  const name = path.split("/").pop() ?? path;
  if (/\.(json|jsonc|json5)$/i.test(name)) return "json";
  if (/\.(sh|bash|zsh|fish|command)$/i.test(name)) return "shell";
  if (/^(Dockerfile|Makefile|\.env(\..+)?|\.zshrc|\.bashrc)$/i.test(name))
    return "shell";
  return "text";
}
