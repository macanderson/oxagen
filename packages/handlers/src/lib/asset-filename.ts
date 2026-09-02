// asset-filename.ts — derive human-readable, URL-friendly filenames for stored
// generated assets.
//
// This is the SINGLE source of truth for an asset's filename, shared by:
//   - conversation.files.list  → the name shown in the Conversation Files panel
//   - generated-asset.serve    → the Content-Disposition filename the browser
//                                 saves the download as / titles the inline view
//
// so the name a user SEES in the panel is byte-identical to the name the file
// SAVES as on disk (no more `gen_…` UUIDs with no extension).
//
// Product requirements:
//   - Always lowercase, hyphen-separated (a URL-friendly slug).
//   - Always carries the correct file extension, derived from the authoritative
//     mimeType and falling back to the asset kind.
//   - Browser-renderable types (images, video, audio, PDF, text/markdown) serve
//     `inline` so clicking the name DISPLAYS the file (or hands it to the OS
//     default app); only non-renderable binaries download as an attachment.

// MIME → file extension (with leading dot). Authoritative over the kind fallback.
const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "text/markdown": ".md",
  "text/plain": ".txt",
  // Mermaid diagram source persisted by mermaid.generate.
  "text/vnd.mermaid": ".mmd",
};

// Asset-kind → extension, used only when the mimeType is unknown/generic.
const EXT_BY_KIND: Record<string, string> = {
  image: ".png",
  video: ".mp4",
  pdf: ".pdf",
  document: ".docx",
  spreadsheet: ".xlsx",
  presentation: ".pptx",
  archive: ".zip",
};

/** The file extension (with leading dot) for an asset, or "" if undeterminable. */
export function extensionForAsset(mimeType: string, kind: string): string {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (EXT_BY_MIME[type]) return EXT_BY_MIME[type]!;
  return EXT_BY_KIND[kind] ?? "";
}

// Strip a leading imperative instruction like "Generate markdown: " or
// "Create image - " that some generators prepend to the stored prompt, so the
// filename reflects the SUBJECT, not the command verb.
const INSTRUCTION_PREFIX =
  /^\s*(?:generate|create|make|write|build|render|draw|produce|compose)\b[^:\n-]*[:-]\s*/i;

function stripInstruction(raw: string): string {
  return raw.replace(INSTRUCTION_PREFIX, "");
}

/** Lowercase, hyphen-separated, URL-friendly slug (ASCII only). */
export function slugify(raw: string): string {
  return raw
    .normalize("NFKD") // split accented chars into base + combining mark
    .replace(/[̀-ͯ]/g, "") // drop the combining marks (diacritics)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics → single hyphen
    .replace(/-{2,}/g, "-") // collapse hyphen runs
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}

const MAX_SLUG_LEN = 60;

export interface AssetNameSource {
  /** The generation prompt (provenance); may carry an instruction prefix. */
  prompt: string | null | undefined;
  kind: string;
  mimeType: string;
  /** User-facing id ("gen_…"), used for the fallback name. */
  publicId: string;
  /** A clean title persisted by the generator (metadata.displayName), preferred. */
  displayName?: string | null;
}

/**
 * Derive the canonical, URL-friendly filename for an asset: a lowercase slug
 * carrying the correct extension, e.g. "uss-nautilus-the-first-nuclear-submarine.md".
 *
 * Resolution order for the base name:
 *   1. An explicit clean title the generator stored (metadata.displayName).
 *   2. The prompt with any leading instruction verb stripped.
 *   3. "<kind>-<last 8 of publicId>" when there is no usable text.
 */
export function assetDisplayName(src: AssetNameSource): string {
  const ext = extensionForAsset(src.mimeType, src.kind);

  const explicit = (src.displayName ?? "").trim();
  const source =
    explicit.length > 0
      ? explicit
      : stripInstruction((src.prompt ?? "").trim());

  let base = slugify(source);

  if (base.length > MAX_SLUG_LEN) {
    // Cut at a hyphen boundary so we never end mid-word; fall back to a hard cut.
    base = base.slice(0, MAX_SLUG_LEN).replace(/-[^-]*$/, "");
    if (base.length === 0) base = slugify(source).slice(0, MAX_SLUG_LEN);
  }

  if (base.length === 0) {
    base = `${slugify(src.kind) || "file"}-${src.publicId.slice(-8).toLowerCase()}`;
  }

  return ext && !base.endsWith(ext) ? `${base}${ext}` : base;
}

export type AssetDisposition = "inline" | "attachment";

// Types the browser executes as markup on whatever origin serves them. They are
// never served inline, however "renderable" they look: nosniff protects against
// a *guessed* content type, not against an honest `Content-Type: text/html`, so
// an inline one is stored XSS on the app's own origin. SVG is markup too — it
// carries <script> — which is why it is listed here rather than with images.
const EXECUTABLE_MARKUP_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "text/xml",
  "application/xhtml+xml",
  "application/xml",
]);

/**
 * Whether an asset should be served `inline` (displayed by the browser / handed
 * to the OS default app) or `attachment` (downloaded). Browser-renderable types
 * display inline so clicking a filename SHOWS the document; everything else —
 * and anything the browser would execute as markup — downloads.
 */
export function assetDispositionType(mimeType: string): AssetDisposition {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (EXECUTABLE_MARKUP_TYPES.has(type)) return "attachment";
  if (type.startsWith("image/")) return "inline";
  if (type.startsWith("video/") || type.startsWith("audio/")) return "inline";
  if (type === "application/pdf") return "inline";
  if (type.startsWith("text/")) return "inline"; // markdown, plain text
  return "attachment";
}

/**
 * Build a complete Content-Disposition header value with both a plain `filename`
 * (ASCII fallback) and an RFC 5987 `filename*` (UTF-8) parameter. Our slugs are
 * ASCII, but the dual encoding keeps us correct if a name ever carries unicode,
 * and quoting/escaping prevents header injection via the filename.
 */
export function contentDispositionHeader(
  disposition: AssetDisposition,
  filename: string,
): string {
  const asciiFallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
