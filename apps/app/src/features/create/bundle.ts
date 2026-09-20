// Reading a skill bundle in the browser (roadmap creation-spec §4, "Upload":
// a `.skill`, a `.zip` or a bare `SKILL.md`, read in the browser and hashed
// there). Nothing here uploads anything: the bytes stay in the tab until the
// pull request carries them, and the digest shown is the one the checks take
// before opening the pull request. Later pushes need a new review.
//
// A `.skill` is a zip archive. The reader below handles the two methods a
// skill bundle uses, stored (0) and deflate (8), with the platform's own
// `DecompressionStream`, so the wizard adds no dependency.

export type Bundle = {
  /** The file the operator picked. */
  fileName: string;
  size: number;
  /** SKILL.md, as text. */
  body: string;
  /** The other text files, relative to the directory SKILL.md sits in. */
  files: { path: string; content: string }[];
  /** `sha256:<hex>` over SKILL.md with LF line ends. */
  digest: string;
};

/** Why a bundle could not be read; each has its own sentence in the catalog. */
export type BundleError =
  | "wrong_type"
  | "too_large"
  | "not_a_zip"
  | "no_skill_md"
  | "unsupported_method"
  | "binary_file"
  | "too_many_files";

export class BundleReadError extends Error {
  constructor(readonly code: BundleError) {
    super(code);
    this.name = "BundleReadError";
  }
}

/** The body limit propose_skill takes (`SKILL_BODY_MAX`), per file. */
const FILE_MAX = 64 * 1024;
/** Files beside SKILL.md propose_skill takes (`SKILL_BUNDLE_FILES_MAX`). */
const FILES_MAX = 16;
/** The largest archive the tab will open. */
const ARCHIVE_MAX = 2 * 1024 * 1024;

type Entry = { path: string; bytes: Uint8Array };

function u16(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The files of a zip archive, from its central directory. Directories are
 * skipped, and so is anything under a dot segment or `__MACOSX/`, which a zip
 * made on a Mac carries and no skill means.
 */
async function readZip(archive: Uint8Array): Promise<Entry[]> {
  // The end-of-central-directory record: signature 0x06054b50, within the
  // last 64 KiB plus its own 22 bytes.
  const floor = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let i = archive.length - 22; i >= floor; i--) {
    if (u32(archive, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new BundleReadError("not_a_zip");
  const count = u16(archive, eocd + 10);
  let at = u32(archive, eocd + 16);
  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(archive, at) !== 0x02014b50) throw new BundleReadError("not_a_zip");
    const method = u16(archive, at + 10);
    const compressed = u32(archive, at + 20);
    const nameLength = u16(archive, at + 28);
    const extraLength = u16(archive, at + 30);
    const commentLength = u16(archive, at + 32);
    const local = u32(archive, at + 42);
    const path = decoder.decode(
      archive.subarray(at + 46, at + 46 + nameLength),
    );
    at += 46 + nameLength + extraLength + commentLength;
    const hidden = path
      .split("/")
      .some((part) => part.startsWith(".") || part === "__MACOSX");
    if (path.endsWith("/") || hidden) continue;
    if (u32(archive, local) !== 0x04034b50)
      throw new BundleReadError("not_a_zip");
    const start =
      local + 30 + u16(archive, local + 26) + u16(archive, local + 28);
    const data = archive.subarray(start, start + compressed);
    if (method === 0) entries.push({ path, bytes: data });
    else if (method === 8) entries.push({ path, bytes: await inflate(data) });
    else throw new BundleReadError("unsupported_method");
  }
  return entries;
}

/** `sha256:<hex>` of `text` with LF line ends, the canonical bytes the handler digests. */
async function digestOf(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.replace(/\r\n/g, "\n"));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, "0"));
  return `sha256:${hex.join("")}`;
}

function text(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new BundleReadError("binary_file");
  if (bytes.length > FILE_MAX) throw new BundleReadError("too_large");
  return new TextDecoder().decode(bytes);
}

/**
 * The SKILL.md and the files beside it. A bundle may wrap everything in one
 * top-level directory (`release-notes/SKILL.md`), as a zip of a folder does;
 * that directory is taken off every path.
 */
function fromEntries(entries: readonly Entry[]): {
  body: string;
  files: { path: string; content: string }[];
} {
  const skill = entries
    .filter((e) => e.path === "SKILL.md" || e.path.endsWith("/SKILL.md"))
    .sort((a, b) => a.path.length - b.path.length)[0];
  if (skill === undefined) throw new BundleReadError("no_skill_md");
  const root = skill.path.slice(0, -"SKILL.md".length);
  const rest = entries.filter((e) => e !== skill && e.path.startsWith(root));
  if (rest.length > FILES_MAX) throw new BundleReadError("too_many_files");
  return {
    body: text(skill.bytes),
    files: rest.map((e) => ({
      path: e.path.slice(root.length),
      content: text(e.bytes),
    })),
  };
}

/** Read the file the operator picked into a bundle, or refuse with a code. */
export async function readBundle(file: File): Promise<Bundle> {
  const lower = file.name.toLowerCase();
  const isMd = lower.endsWith(".md");
  if (!isMd && !lower.endsWith(".skill") && !lower.endsWith(".zip"))
    throw new BundleReadError("wrong_type");
  if (file.size > (isMd ? FILE_MAX : ARCHIVE_MAX))
    throw new BundleReadError("too_large");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { body, files } = isMd
    ? { body: text(bytes), files: [] }
    : fromEntries(await readZip(bytes));
  return {
    fileName: file.name,
    size: file.size,
    body,
    files,
    digest: await digestOf(body),
  };
}
