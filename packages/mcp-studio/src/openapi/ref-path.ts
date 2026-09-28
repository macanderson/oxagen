// ref-path.ts: where a $ref points, checked against the files import holds.
//
// Import never reads a disk or fetches a URL. A $ref to another file
// resolves against the in-memory file list after one normalization:
// percent-decode, turn backslashes into slashes, and collapse `.` and `..`.
// A ref that names a URL, an absolute path, or a file outside the folder is
// refused with the ref named.
import { OpenApiImportError } from "./errors";
import { pointerTokens } from "./json";

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Where a $ref points: a file among the inputs, and a JSON Pointer inside it. */
export interface RefTarget {
  file: string;
  tokens: string[];
}

function outside(ref: string, from: string): OpenApiImportError {
  return new OpenApiImportError(
    "ref_outside",
    `The $ref "${ref}" in ${from} points outside the folder. Import reads only the files in the folder ` +
      "and never fetches a URL. Copy the file into the folder and refer to it by a relative path.",
    { ref },
  );
}

function missing(ref: string, from: string, why: string): OpenApiImportError {
  return new OpenApiImportError("ref_missing", `The $ref "${ref}" in ${from} ${why}`, { ref });
}

/**
 * Collapses `.` and `..` in a slash-separated path. Returns undefined when
 * a `..` climbs above the folder.
 */
function collapse(segments: readonly string[]): string | undefined {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
}

/**
 * A file's path as import keys it: slashes only, no `.` segments, no leading
 * `./`. Returns undefined for an absolute path or one that climbs above the
 * folder.
 */
export function normalizePath(path: string): string | undefined {
  const slashed = path.replace(/\\/g, "/");
  if (slashed.startsWith("/") || SCHEME.test(slashed)) return undefined;
  const collapsed = collapse(slashed.split("/"));
  return collapsed === "" ? undefined : collapsed;
}

function dirname(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  return parts;
}

/**
 * Resolves a $ref that is not a bare `#` fragment. `fromFile` is the
 * normalized path of the file that holds the ref, and `files` holds every
 * normalized path import was given.
 */
export function resolveRefPath(ref: string, fromFile: string, files: ReadonlySet<string>): RefTarget {
  const hash = ref.indexOf("#");
  const rawPath = hash === -1 ? ref : ref.slice(0, hash);
  const rawFragment = hash === -1 ? "" : ref.slice(hash + 1);

  let file = fromFile;
  if (rawPath !== "") {
    if (SCHEME.test(rawPath) || rawPath.startsWith("//")) throw outside(ref, fromFile);
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      throw missing(ref, fromFile, "is not a valid URI reference. Fix the $ref and import again.");
    }
    const slashed = decoded.replace(/\\/g, "/");
    if (slashed.startsWith("/") || SCHEME.test(slashed)) throw outside(ref, fromFile);
    const joined = collapse([...dirname(fromFile), ...slashed.split("/")]);
    if (joined === undefined || joined === "") throw outside(ref, fromFile);
    if (!files.has(joined)) {
      throw missing(
        ref,
        fromFile,
        `names ${joined}, which is not in the folder. Add the file, or fix the $ref, and import again.`,
      );
    }
    file = joined;
  }

  let fragment: string;
  try {
    fragment = decodeURIComponent(rawFragment);
  } catch {
    throw missing(ref, fromFile, "has a fragment that is not valid. Fix the $ref and import again.");
  }
  if (fragment !== "" && !fragment.startsWith("/")) {
    throw missing(
      ref,
      fromFile,
      "uses an anchor. Import follows JSON Pointer fragments only, such as #/components/schemas/Pet.",
    );
  }
  return { file, tokens: pointerTokens(fragment) };
}
