/**
 * glob.ts — path glob → RegExp, once for the whole repository.
 *
 * Four packages carried a copy of this function: `@oxagen/agent-engine`,
 * `@oxagen/github`, `@oxagen/agent` and `@oxagen/ingestion`. Three were
 * byte-identical and the fourth was the same rules written a different way.
 * Nothing made them agree and nothing noticed when one drifted — which is how a
 * fifth copy came to be missing the line that consumes the separator after a
 * double star, and denied secrets everywhere except the workspace root
 * (#1387).
 *
 * The copies sat at one trust boundary, all four filtering paths, so unlike the
 * canonicalizers of ADR-041 there was nothing for them to disagree about. That
 * is the whole argument for merging these and not those.
 *
 * ## The rules
 *
 * - `**` matches any run of characters, separators included.
 * - `**` followed by a separator matches zero or more whole segments: `**` then
 *   `/.env` matches `.env` at the root, and `a/b/.env`, and nothing else. Every
 *   copy either consumed that separator or was a defect for not consuming it —
 *   and every copy that did consume it then emitted a bare `.*`, so the pattern
 *   also reached `foo.env`. A rule about a file is not a rule about every name
 *   ending in it, so this compiles to an optional run of segments instead.
 * - A single `*` matches within one segment: it never crosses a `/`.
 * - `?` matches exactly one character that is not a separator.
 * - Everything else is literal, regex metacharacters escaped.
 * - The pattern is anchored at both ends. `src/x` does not match `a/src/x`.
 *
 * ## What it is not
 *
 * There is no brace expansion, no character class, no negation, and no `extglob`.
 * A pattern using them matches literally, which fails closed for an allow rule
 * and open for a deny rule — so a deny rule wants a plain pattern.
 *
 * `matchGlob` in `@oxagen/mcp-config` is a different function on purpose: it
 * matches flat values (MCP tool names, URLs) where `*` is expected to cross
 * every separator. Do not merge the two; a tool-name rule and a path rule mean
 * different things by the same character.
 */

/** Compile a path glob to an anchored `RegExp`. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          // Zero or more whole segments. Emitting `.*` and consuming the
          // separator required no directory but also respected no boundary;
          // emitting `.*/` required one. This is the only shape that is
          // neither.
          re += "(?:.*/)?";
          i++;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c as string)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Whether `path` matches `pattern`. Compiles the pattern on every call. */
export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}
