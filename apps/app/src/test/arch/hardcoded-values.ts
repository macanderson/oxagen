// INV-37 (ARCHITECTURE.md §4): no module or stylesheet rule in the app writes
// a value by hand. Mac set the rule on 2026-10-03: "i want
// 14px to be the base and i never want to see hard coded font sizes or any
// other form of hard coded value anywhere in the html - i am trying to get us
// closer to using the baseui/shadcn tokens out of the box", and widened it the
// same day: "make sure you take the time to check buttons, border radius,
// colors etc - everything has to be semantic driven from tokens" (#5283). A
// value reaches the page through a Tailwind scale step, a theme utility, a
// kit component, or a token.
//
// This module holds the scan and the baseline comparison.
// hardcoded-values.test.ts runs them over src/, and
// scripts/hardcoded-values-baseline.ts writes apps/app/hardcoded-values-baseline.json
// from the tree.
//
// In a module (`.ts`, `.tsx`), the scan finds:
// - A Tailwind arbitrary value in any string: `gap-[10px]`, `md:max-w-[720px]`,
//   `bg-black/[0.35]`, `[overflow-wrap:anywhere]`, or an arbitrary breakpoint
//   such as `min-[67.5rem]:grid-cols-3`. A CSS-wide keyword in brackets,
//   such as `rounded-[inherit]`, writes no value. A bracket in a state variant
//   (`data-[state=open]:`, `aria-[sort=ascending]:`, `has-[>svg]:`,
//   `group-data-[…]:`, `peer-…-[…]:`, `supports-[…]:`, `[&>svg]:`) selects an
//   element and holds no value, so it does not count. Tailwind's variable
//   form, `w-(--sidebar-width)`, names a token and does not count either.
// - A bare `rounded`, Tailwind's fixed 0.25rem, which reads no kit step.
//   `rounded-sm` and the other steps read the kit's `--radius-*`.
// - A duration or delay step, `duration-200` or `delay-150`. Motion reads the
//   kit's `--motion-*` tokens: `duration-(--motion-base)`. Tailwind's named
//   easings (`ease-out`) read its `--ease-*` theme tokens, so they pass.
// - A literal number or length in an inline `style={{…}}`: `width: 240`,
//   `padding: "6px 8px"`, `calc(100% - 12px)`, or a literal fallback such as
//   `width ?? 240`. A value computed from data at runtime, such as `${pct}%`,
//   holds no literal and does not count. A style object built outside the
//   attribute (`style={side}`) is not read.
// - A raw `<button>` element. Every button is the kit's `Button`
//   (src/ui/button.tsx) with one of its variants.
// - A named colour, such as `fill="white"` or `color: "red"`, in a JSX
//   attribute or a style value. Hex, colour functions, and Tailwind palette
//   classes are INV-32's scan (design-record.test.ts), so this one does not
//   repeat them.
//
// In a stylesheet's rules, the scan finds a literal length or time in a
// radius, shadow, spacing, sizing, or motion declaration (`border-radius:
// 6px`, `box-shadow: 0 0 0 1px var(--gold)`, `padding: 6px 8px`, `animation:
// x 1.2s linear`), and a named colour in a colour declaration. A custom
// property definition (`--side-w: 236px`) is the token-mapping layer, where
// raw values become tokens, so the scan does not read it. Zero, `9999px` for
// a round corner, and a share of a box or the viewport (`50%`, `68vh`, `1fr`)
// are not values to tokenise.
// A unitless number, such as the `2` in `calc(var(--ox-space) * 2)`, scales a
// token and passes.
//
// The baseline is an object rather than knip-baseline.json's flat array,
// because a documented exception needs a home for its reason: file → token →
// a count of values still waiting for a token, or the reason an exception
// keeps its value.
import ts from "typescript";
import { isTestOnly, listFiles, parse, readSource } from "./parse";

/** One hard-coded value: a class as written, or a prefixed token such as `style:width` or `css:border-radius`. */
export type Finding = {
  readonly file: string;
  readonly line: number;
  readonly token: string;
};

/**
 * The baseline: file → token → allowance. A number is the count of that token
 * the file still holds, waiting for a token to replace it. A string is the
 * reason a documented exception keeps its value, and allows the token at any
 * count.
 */
export type Baseline = Readonly<
  Record<string, Readonly<Record<string, number | string>>>
>;

export type BaselineDiff = {
  /** A value the baseline does not allow: `<file>:<line> <token>`. */
  readonly added: readonly string[];
  /** A baseline entry the scan no longer finds as often: `<file> <token> …`. */
  readonly stale: readonly string[];
};

/** The token a raw `<button>` element reports. */
export const RAW_BUTTON = "<button>";

/** The kit's button, the one module that may render a button element itself. */
const BUTTON_MODULE = "src/ui/button.tsx";

/** `<utility>-[<value>]`, with an optional `/<modifier>`: `gap-[10px]`, `bg-[var(--x)]/50`. */
const ARBITRARY_VALUE =
  /^[a-z@][a-z0-9-]*-\[\S+\](?:\/(?:\[[^\]\s]+\]|[\w.%-]+))?$/;

/** A named utility with an arbitrary modifier: `bg-black/[0.35]`, `text-sm/[1.4]`. */
const ARBITRARY_MODIFIER = /^[a-z@][a-z0-9-]*\/\[\S+\]$/;

/** An arbitrary property: `[mask-type:alpha]`, `[--rail:12px]`. */
const ARBITRARY_PROPERTY = /^\[(?:--)?[a-z][a-z0-9-]*:\S+\]$/;

/** A breakpoint or container size in brackets: `max-[600px]:`, `@min-[24rem]:`. */
const ARBITRARY_BREAKPOINT = /^(?:@?(?:min|max)-|@)\[[^\]]+\]$/;

/** A bare corner, Tailwind's fixed 0.25rem: `rounded`, `rounded-t`. */
const BARE_RADIUS = /^rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?$/;

/** A duration or delay step: `duration-200`, `delay-75`. */
const MOTION_STEP = /^(?:duration|delay)-\d+$/;

/** A CSS-wide keyword in brackets, such as `rounded-[inherit]`: it takes the parent's value and writes none. */
const KEYWORD_VALUE = /-\[(?:inherit|initial|unset|revert)\]$/;

/**
 * A number that is not part of a name: `12px`, `-50%`, `0.4`, the `100` in
 * `calc(100% - 1rem)`, but not the `2` in `var(--ox-gray-2)`.
 */
const LITERAL_NUMBER = /(?<![\w-])-?(?:\d+\.?\d*|\.\d+)/;

/** A number with a unit in a CSS value: `6px`, `1.2s`, `-50%`. */
const CSS_QUANTITY = /(?<![\w#-])-?(?:\d+\.?\d*|\.\d+)(%|[a-z]+)/gi;

/** Units that state a share of a box or the viewport, not a size: `38%`, `68vh`, `1fr`. */
const PROPORTION_UNITS = new Set([
  "%",
  "fr",
  "vw",
  "vh",
  "dvh",
  "svh",
  "lvh",
  "vmin",
  "vmax",
  "cqw",
  "cqh",
  "cqi",
  "cqb",
]);

/** The text that stands in for a `${…}` substitution in a template. */
const SUBSTITUTION = "${}";

/** The CSS named colours but `transparent` and `currentColor`, which carry no colour of their own. */
const NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black " +
    "blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse " +
    "chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta " +
    "darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite " +
    "forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green " +
    "greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender " +
    "lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink " +
    "lightsalmon lightseagreen lightskyblue lightslategray lightslategrey " +
    "lightsteelblue lightyellow lime limegreen linen magenta maroon " +
    "mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise " +
    "palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey " +
    "snow springgreen steelblue tan teal thistle tomato turquoise violet " +
    "wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

/** JSX attributes that take a colour. */
const COLOUR_ATTRIBUTES = new Set([
  "color",
  "fill",
  "stroke",
  "stopColor",
  "floodColor",
  "lightingColor",
]);

/** A style or CSS property that takes a colour: `color`, `backgroundColor`, `border-top-color`, `fill`. */
const COLOUR_PROPERTY =
  /^(?:color|fill|stroke|stop-?color|flood-?color|lighting-?color|caret-?color|accent-?color|background(?:-?color)?|border(?:-?(?:top|right|bottom|left|block|inline)(?:-?(?:start|end))?)?(?:-?color)?|outline(?:-?color)?|text-?decoration(?:-?color)?|column-?rule(?:-?color)?)$/i;

/**
 * The stylesheet declarations the scan reads, each with the quantities it
 * accepts. A declaration of any other property, and every custom property
 * definition, is not read.
 */
const CSS_RULES: readonly {
  readonly property: RegExp;
  readonly allowed: ReadonlySet<string>;
}[] = [
  {
    property:
      /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/,
    allowed: new Set(["50%", "9999px"]),
  },
  { property: /^(?:box|text)-shadow$/, allowed: new Set() },
  {
    property:
      /^(?:padding|margin|scroll-(?:padding|margin))(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?$|^(?:row-|column-)?gap$|^inset(?:-(?:block|inline)(?:-(?:start|end))?)?$|^(?:top|right|bottom|left)$/,
    allowed: new Set(),
  },
  {
    property: /^(?:min-|max-)?(?:width|height|block-size|inline-size)$/,
    allowed: new Set(["100%"]),
  },
  {
    property:
      /^(?:transition|animation)(?:-(?:duration|delay|timing-function))?$/,
    allowed: new Set(),
  },
];

/** An easing written by hand in a motion declaration. */
const CSS_EASING =
  /cubic-bezier\(|steps\(|(?<![\w-])(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)(?![\w-])/;

/** A token's segments split at the colons outside brackets and parentheses: variants, then the utility. */
function segments(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0) {
      parts.push(token.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(token.slice(start));
  return parts;
}

/** Whether one whitespace-free token from a string is a class holding a hard-coded value. */
export function isHardcodedClass(token: string): boolean {
  const parts = segments(token);
  const utility = (parts.pop() ?? "").replace(/^!|!$/g, "").replace(/^-/, "");
  if (parts.some((variant) => ARBITRARY_BREAKPOINT.test(variant))) return true;
  if (KEYWORD_VALUE.test(utility)) return false;
  return (
    ARBITRARY_VALUE.test(utility) ||
    ARBITRARY_MODIFIER.test(utility) ||
    ARBITRARY_PROPERTY.test(utility) ||
    MOTION_STEP.test(utility) ||
    BARE_RADIUS.test(utility)
  );
}

/** A string node's text, each `${…}` in a template replaced by SUBSTITUTION. */
function stringText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans
        .map((span) => SUBSTITUTION + span.literal.text)
        .join("")
    );
  }
  return undefined;
}

/** The plain expression under parentheses and type assertions. */
function unwrap(expr: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
    ? unwrap(expr.expression)
    : expr;
}

/** The values an expression can take when it is a literal: both branches of a conditional, a fallback after `??` or `||`. */
function literalBranches(expr: ts.Expression): ts.Expression[] {
  const inner = unwrap(expr);
  if (ts.isConditionalExpression(inner)) {
    return [
      ...literalBranches(inner.whenTrue),
      ...literalBranches(inner.whenFalse),
    ];
  }
  if (ts.isBinaryExpression(inner)) {
    const op = inner.operatorToken.kind;
    return op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.BarBarToken
      ? literalBranches(inner.right)
      : [];
  }
  return [inner];
}

/** Whether an inline style value holds a literal number or length. */
function holdsLiteral(expr: ts.Expression): boolean {
  return literalBranches(expr).some((branch) => {
    if (ts.isNumericLiteral(branch)) return true;
    if (ts.isPrefixUnaryExpression(branch)) {
      return ts.isNumericLiteral(branch.operand);
    }
    const text = stringText(branch);
    return text !== undefined && LITERAL_NUMBER.test(text);
  });
}

/** Whether a value names a colour: `"white"`, `cond ? "red" : x`. */
function namesColour(expr: ts.Expression): boolean {
  return literalBranches(expr).some((branch) => {
    const text = stringText(branch);
    return text !== undefined && NAMED_COLOURS.has(text.trim().toLowerCase());
  });
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return name.getText();
}

function lineAt(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Every inline style literal and named colour under a `style` attribute's value. */
function styleFindings(
  file: string,
  sf: ts.SourceFile,
  value: ts.Node,
): Finding[] {
  const found: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        const line = lineAt(sf, property.getStart(sf));
        if (holdsLiteral(property.initializer)) {
          found.push({ file, line, token: `style:${name}` });
        }
        if (COLOUR_PROPERTY.test(name) && namesColour(property.initializer)) {
          found.push({ file, line, token: `colour:${name}` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(value);
  return found;
}

/** A JSX attribute's value as an expression: `"white"` or `{"white"}`. */
function attributeValue(attr: ts.JsxAttribute): ts.Expression | undefined {
  const init = attr.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init;
  if (ts.isJsxExpression(init)) return init.expression;
  return undefined;
}

/** Every hard-coded value in one module's source text. */
export function scanModule(file: string, text: string): Finding[] {
  const sf = parse({ file, text });
  const found: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const value = attributeValue(node);
      if (name === "style" && node.initializer) {
        found.push(...styleFindings(file, sf, node.initializer));
      } else if (
        COLOUR_ATTRIBUTES.has(name) &&
        value !== undefined &&
        namesColour(value)
      ) {
        found.push({
          file,
          line: lineAt(sf, node.getStart(sf)),
          token: `colour:${name}`,
        });
      }
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === "button" &&
      file !== BUTTON_MODULE
    ) {
      found.push({
        file,
        line: lineAt(sf, node.getStart(sf)),
        token: RAW_BUTTON,
      });
    }
    const content = stringText(node);
    if (content !== undefined) {
      const startLine = lineAt(sf, node.getStart(sf));
      for (const match of content.matchAll(/\S+/g)) {
        if (!isHardcodedClass(match[0])) continue;
        const before = content.slice(0, match.index);
        found.push({
          file,
          line: startLine + (before.match(/\n/g)?.length ?? 0),
          token: match[0],
        });
      }
      // A template's substitutions can hold strings of their own.
      if (!ts.isTemplateExpression(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return byPosition(found);
}

/** `text` with every `var(…)` removed, nested parentheses included. */
function withoutVars(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("var(", i)) {
      let depth = 0;
      let j = i + 3;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      i = j + 1;
      continue;
    }
    out += text.charAt(i);
    i++;
  }
  return out;
}

/** `text` with each comment blanked out and its newlines kept, so line numbers still count. */
function withoutCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
}

/** Whether a CSS declaration's value holds a value the scan reports. */
function cssValueHardcoded(property: string, value: string): boolean {
  const rule = CSS_RULES.find((r) => r.property.test(property));
  if (!rule) return false;
  const plain = withoutVars(value).replace(/!important/g, "");
  const quantity = [...plain.matchAll(CSS_QUANTITY)].some((m) => {
    const written = m[0].replace(/^-/, "").toLowerCase();
    return (
      Number.parseFloat(written) !== 0 &&
      !PROPORTION_UNITS.has((m[1] ?? "").toLowerCase()) &&
      !rule.allowed.has(written)
    );
  });
  return (
    quantity ||
    (/^(?:transition|animation)/.test(property) && CSS_EASING.test(plain))
  );
}

/** Every hard-coded value in one stylesheet's rules. */
export function scanStylesheet(file: string, text: string): Finding[] {
  const css = withoutCssComments(text);
  const found: Finding[] = [];
  const declaration = /(^|[{;\s])([a-z][a-z-]*)\s*:\s*([^;{}]*)/g;
  for (const m of css.matchAll(declaration)) {
    const property = (m[2] ?? "").toLowerCase();
    const value = m[3] ?? "";
    const line =
      css.slice(0, m.index + (m[1] ?? "").length).split("\n").length;
    if (cssValueHardcoded(property, value)) {
      found.push({ file, line, token: `css:${property}` });
    }
    if (
      COLOUR_PROPERTY.test(property) &&
      withoutVars(value)
        .toLowerCase()
        .split(/[^a-z]+/)
        .some((word) => NAMED_COLOURS.has(word))
    ) {
      found.push({ file, line, token: `colour:${property}` });
    }
  }
  return byPosition(found);
}

function byPosition(found: Finding[]): Finding[] {
  return found.sort(
    (a, b) => a.line - b.line || a.token.localeCompare(b.token),
  );
}

/** The files the rule covers: every module and stylesheet under src/ but tests, test helpers and probes. */
export function scannedFiles(): string[] {
  return listFiles("src").filter(
    (file) => /\.(tsx?|css)$/.test(file) && !isTestOnly(file),
  );
}

/** Every hard-coded value in one file under the rule. */
export function scanFile(file: string, text: string): Finding[] {
  return file.endsWith(".css")
    ? scanStylesheet(file, text)
    : scanModule(file, text);
}

/** Every hard-coded value in the files the rule covers. */
export function scanTree(): Finding[] {
  return scannedFiles().flatMap((file) =>
    scanFile(file, readSource(file).text),
  );
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * The baseline the tree supports: every documented exception the scan still
 * finds keeps its reason, and every other value is counted. Files and tokens
 * are sorted, so the file diffs cleanly.
 */
export function baselineFor(
  findings: readonly Finding[],
  current: Baseline,
): Record<string, Record<string, number | string>> {
  const counts = new Map<string, Map<string, number>>();
  for (const { file, token } of findings) {
    const byToken = counts.get(file) ?? new Map<string, number>();
    byToken.set(token, (byToken.get(token) ?? 0) + 1);
    counts.set(file, byToken);
  }
  const out: Record<string, Record<string, number | string>> = {};
  for (const [file, byToken] of counts) {
    const entry: Record<string, number | string> = {};
    for (const [token, count] of byToken) {
      const reason = current[file]?.[token];
      entry[token] = typeof reason === "string" ? reason : count;
    }
    out[file] = sortKeys(entry);
  }
  return sortKeys(out);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baselineError(why: string): Error {
  return new Error(`hardcoded-values-baseline.json: ${why}`);
}

/** The baseline file's text, read strictly: file → token → a positive count or a reason. */
export function parseBaseline(text: string): Baseline {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw baselineError("expected an object of files");
  const out: Record<string, Record<string, number | string>> = {};
  for (const [file, byToken] of Object.entries(data)) {
    if (!isRecord(byToken)) {
      throw baselineError(`${file}: expected an object of tokens`);
    }
    const entry: Record<string, number | string> = {};
    for (const [token, allowance] of Object.entries(byToken)) {
      if (
        typeof allowance === "number" &&
        Number.isInteger(allowance) &&
        allowance > 0
      ) {
        entry[token] = allowance;
      } else if (typeof allowance === "string" && allowance.trim() !== "") {
        entry[token] = allowance;
      } else {
        throw baselineError(
          `${file} ${token}: expected a positive count or the reason for an exception`,
        );
      }
    }
    if (Object.keys(entry).length === 0) {
      throw baselineError(`${file}: holds no token`);
    }
    out[file] = entry;
  }
  return out;
}

/** What the tree holds beyond the baseline, and what the baseline holds beyond the tree. */
export function diffBaseline(
  findings: readonly Finding[],
  baseline: Baseline,
): BaselineDiff {
  const lines = new Map<string, Map<string, number[]>>();
  for (const { file, line, token } of findings) {
    const byToken = lines.get(file) ?? new Map<string, number[]>();
    byToken.set(token, [...(byToken.get(token) ?? []), line]);
    lines.set(file, byToken);
  }
  const added: string[] = [];
  for (const [file, byToken] of lines) {
    for (const [token, at] of byToken) {
      const allowance = baseline[file]?.[token];
      if (typeof allowance === "string") continue;
      const allowed = allowance ?? 0;
      if (at.length <= allowed) continue;
      const note =
        allowed > 0
          ? ` (baseline ${String(allowed)}, found ${String(at.length)})`
          : "";
      for (const line of at) {
        added.push(`${file}:${String(line)} ${token}${note}`);
      }
    }
  }
  const stale: string[] = [];
  for (const [file, byToken] of Object.entries(baseline)) {
    for (const [token, allowance] of Object.entries(byToken)) {
      const found = lines.get(file)?.get(token)?.length ?? 0;
      if (typeof allowance === "string") {
        if (found === 0) stale.push(`${file} ${token} (exception, found 0)`);
      } else if (found < allowance) {
        stale.push(
          `${file} ${token} (baseline ${String(allowance)}, found ${String(found)})`,
        );
      }
    }
  }
  return { added: added.sort(), stale: stale.sort() };
}
