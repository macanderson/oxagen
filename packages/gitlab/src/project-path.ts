/** GitLab allows 20 levels of subgroups under a top-level group, plus the project itself. */
const MAX_SEGMENTS = 20 + 1;
const MIN_SEGMENTS = 2;
const MAX_SEGMENT_LENGTH = 255;
const MAX_PATH_LENGTH = 1024;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Validates a gitlab.com project path, including nested groups
 * ("a/b/c/project"). Returns null when the input is invalid.
 *
 * The input is refused rather than normalised: surrounding whitespace, a
 * leading or trailing slash, and a trailing ".git" all return null. A path
 * that is quietly repaired here would name a different project than the one
 * the person typed, and the caller is better placed to say what was wrong.
 *
 * Each segment is 1 to 255 characters of letters, digits, `_`, `.`, and `-`,
 * starts with a letter, digit, or underscore, contains no "..", and does not
 * end in ".git" or ".atom". GitLab reserves those two suffixes for its own
 * routes.
 */
export function parseGitLabProjectPath(
  input: string,
): { namespace: string; path: string; fullPath: string } | null {
  if (typeof input !== "string") return null;
  if (input.length === 0 || input.length > MAX_PATH_LENGTH) return null;

  const segments = input.split("/");
  if (segments.length < MIN_SEGMENTS || segments.length > MAX_SEGMENTS) {
    return null;
  }
  for (const segment of segments) {
    if (!isValidSegment(segment)) return null;
  }

  const path = segments[segments.length - 1] as string;
  return {
    namespace: segments.slice(0, -1).join("/"),
    path,
    fullPath: input,
  };
}

function isValidSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH) return false;
  if (!SEGMENT.test(segment)) return false;
  if (segment.includes("..")) return false;
  const lower = segment.toLowerCase();
  return !lower.endsWith(".git") && !lower.endsWith(".atom");
}
