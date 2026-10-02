/**
 * Links that send a download to a GitHub release. The repository is private
 * and has changed owner more than once, so a release asset URL answers 404 to
 * anyone outside the organization, an installed app included. Every file a
 * release ships is served from downloads.oxagen.sh instead (ADR-247).
 * `release-hosting.tree.test.ts` runs this over the tracked tree, so a link
 * like that cannot come back into an app, the docs, or the packaging
 * templates.
 */

export interface ReleaseLink {
  /** 1-based line number. */
  line: number;
  /** The text that matched. */
  text: string;
  /** Why the line fails, in words a reader can act on. */
  why: string;
}

const RULES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    // `github.com/<owner>/<repo>/releases`, then `/download/…`, `/tag/…`,
    // `/latest`, `.atom`, or nothing. Any owner: the next move would change it.
    pattern: /github\.com\/[\w.-]+\/[\w.-]+\/releases(?![\w-])/g,
    why: "links a GitHub release",
  },
  {
    // The same URL built from a constant, `${REPO}/releases/download/…` in
    // TypeScript or `#{repo}/releases/tag/…` in Ruby.
    pattern: /(?:\$\{[^}]*\}|#\{[^}]*\})\/releases\/(?:download|tag|latest)\//g,
    why: "builds a GitHub release URL from a variable",
  },
  {
    pattern: /\bgh release download\b/g,
    why: "downloads from a GitHub release",
  },
];

/** Every release link in `text`, in line order. */
export function findReleaseLinks(text: string): ReleaseLink[] {
  const found: ReleaseLink[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        found.push({ line: index + 1, text: match[0], why: rule.why });
      }
    }
  }
  return found;
}

const SCANNED_ROOTS = ["apps/", "tools/packaging/"];

const TEXT_FILE =
  /\.(?:[cm]?[jt]sx?|mdx?|json|ya?ml|toml|rb|sh|rs|html|txt)$/;

/**
 * Tests and their fixtures are left out: the run-work feature renders the
 * releases of the repositories Oxagen governs, and its tests carry
 * `github.com/acme/…/releases` on purpose. `docs/` is left out too, because
 * its ADRs and specs record where the files used to live.
 */
const EXCLUDED =
  /(?:\.test\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|__fixtures__|fixtures|e2e|node_modules)\/)/;

/** Whether the guard reads the tracked file at `path` (repository-relative). */
export function scansForReleaseLinks(path: string): boolean {
  if (!SCANNED_ROOTS.some((root) => path.startsWith(root))) return false;
  if (EXCLUDED.test(path)) return false;
  return TEXT_FILE.test(path);
}
