// Syntax tokens for the TOML subset an agent definition file uses
// (toml-subset.ts). The source editor paints the draft from these on every
// keystroke and the Definition tab paints the committed file, so the scanner
// never throws and never drops a character: every byte of the source lands in
// exactly one token, in order, and text it cannot read is a `text` token. It
// colours; parseTomlSubset judges. Pure and edge-safe.

export type TomlTokenKind =
  | "comment"
  | "table"
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "punct"
  | "text";

export type TomlToken = { kind: TomlTokenKind; text: string };

// Sticky, so a match reads at the cursor without slicing the source.
const BARE_KEY = /[A-Za-z0-9_.-]+/y;
const QUOTED_KEY = /"[^"\n]*"|'[^'\n]*'/y;
const BOOLEAN = /(?:true|false)\b/y;
const NUMBER = /[-+]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][-+]?\d+)?\b/y;
const TABLE_HEADER = /\[\[?[^\]\n]*\]?\]?/y;
const WHITESPACE = /[ \t]+/y;
const COMMENT = /#[^\n]*/y;

class Scanner {
  private pos = 0;
  private readonly tokens: TomlToken[] = [];

  constructor(private readonly src: string) {}

  get done(): boolean {
    return this.pos >= this.src.length;
  }

  peek(): string {
    return this.src[this.pos] ?? "";
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  /** Emits the regex match at the cursor as one token; false when it does not match. */
  match(re: RegExp, kind: TomlTokenKind): boolean {
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    if (m === null || m[0].length === 0) return false;
    this.emit(kind, m[0]);
    return true;
  }

  /** Emits `n` characters at the cursor. */
  take(kind: TomlTokenKind, n: number): void {
    this.emit(kind, this.src.slice(this.pos, this.pos + n));
  }

  private emit(kind: TomlTokenKind, text: string): void {
    this.pos += text.length;
    const last = this.tokens[this.tokens.length - 1];
    if (last !== undefined && last.kind === kind && kind === "text") {
      last.text += text;
    } else {
      this.tokens.push({ kind, text });
    }
  }

  /** A string opened by `quote` (one or three characters) up to and including its close; to the end of the line for a single-line string left open. */
  string(quote: string): void {
    const multi = quote.length === 3;
    const escapes = quote[0] === '"';
    let i = this.pos + quote.length;
    for (; i < this.src.length; i++) {
      const c = this.src[i];
      if (escapes && c === "\\") {
        i++;
        continue;
      }
      if (!multi && c === "\n") break;
      if (this.src.startsWith(quote, i)) {
        i += quote.length;
        break;
      }
    }
    this.emit("string", this.src.slice(this.pos, i));
  }

  result(): TomlToken[] {
    return this.tokens;
  }
}

function whitespace(s: Scanner): void {
  s.match(WHITESPACE, "text");
}

/** The rest of the line: a comment, or text the file should not have there. */
function lineTail(s: Scanner): void {
  while (!s.done && s.peek() !== "\n") {
    whitespace(s);
    // peek() is "" at the end, so one test covers the line end and the file end.
    if (s.peek() === "\n" || s.peek() === "") break;
    if (!s.match(COMMENT, "comment")) s.take("text", 1);
  }
}

function key(s: Scanner): boolean {
  return s.match(QUOTED_KEY, "key") || s.match(BARE_KEY, "key");
}

/** One value at the cursor; false when nothing there reads as one. */
function value(s: Scanner): boolean {
  if (s.startsWith('"""')) {
    s.string('"""');
    return true;
  }
  if (s.startsWith("'''")) {
    s.string("'''");
    return true;
  }
  const c = s.peek();
  if (c === '"' || c === "'") {
    s.string(c);
    return true;
  }
  if (s.match(BOOLEAN, "boolean") || s.match(NUMBER, "number")) return true;
  if (c === "[") {
    s.take("punct", 1);
    array(s);
    return true;
  }
  if (c === "{") {
    s.take("punct", 1);
    inlineTable(s);
    return true;
  }
  return false;
}

/** After `[`: values and commas, with comments and newlines between, to `]`. */
function array(s: Scanner): void {
  while (!s.done) {
    whitespace(s);
    const c = s.peek();
    if (c === "\n") {
      s.take("text", 1);
      continue;
    }
    if (c === "#") {
      s.match(COMMENT, "comment");
      continue;
    }
    if (c === "]") {
      s.take("punct", 1);
      return;
    }
    if (c === ",") {
      s.take("punct", 1);
      continue;
    }
    if (c === "") return;
    if (!value(s)) s.take("text", 1);
  }
}

/** After `{`: key = value pairs and commas on one line, to `}`. */
function inlineTable(s: Scanner): void {
  while (!s.done) {
    whitespace(s);
    const c = s.peek();
    if (c === "}") {
      s.take("punct", 1);
      return;
    }
    if (c === "\n" || c === "") return;
    if (c === ",") {
      s.take("punct", 1);
      continue;
    }
    if (key(s)) {
      whitespace(s);
      if (s.peek() === "=") {
        s.take("punct", 1);
        whitespace(s);
        if (!value(s) && s.peek() !== "}" && s.peek() !== "\n") {
          s.take("text", 1);
        }
      }
      continue;
    }
    s.take("text", 1);
  }
}

/** One line from its first column: blank, comment, table header, or key = value. */
function line(s: Scanner): void {
  whitespace(s);
  const c = s.peek();
  if (c === "\n" || c === "") return;
  if (c === "#") {
    s.match(COMMENT, "comment");
    return;
  }
  if (c === "[") {
    s.match(TABLE_HEADER, "table");
    lineTail(s);
    return;
  }
  if (key(s)) {
    whitespace(s);
    if (s.peek() === "=") {
      s.take("punct", 1);
      whitespace(s);
      value(s);
    }
  }
  lineTail(s);
}

/** Every character of `source`, in order, as syntax tokens. */
export function tokenizeToml(source: string): TomlToken[] {
  const s = new Scanner(source);
  while (!s.done) {
    line(s);
    if (s.peek() === "\n") s.take("text", 1);
  }
  return s.result();
}
