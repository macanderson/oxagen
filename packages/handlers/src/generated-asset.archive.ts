// generated-asset.archive.ts — stream a set of generated assets as one ZIP.
//
// Raw data access, not a kernel capability (same class as generated-asset.serve):
// the caller lists the assets through the metered `list_conversation_files`
// capability first, then this helper turns that already-authorised list into a
// single ZIP download. Every entry's bytes are still fetched through
// serveGeneratedAsset(), so the per-asset access policy (public/org/user) is
// re-enforced per file and per-file `generated_asset.served` telemetry fires —
// an id smuggled into the entry list cannot leak bytes the principal couldn't
// download individually.
//
// Memory profile: entries are streamed into the archive SEQUENTIALLY via
// fflate's streaming Zip, so no whole file is ever held at once (unlike
// archive.create.ts, which zipSync's in-memory blobs it already holds).
// Caveat: production happens in `start()`, which enqueues without consulting
// `controller.desiredSize`, so there is no backpressure — a consumer slower
// than the blob reads lets the stream's internal queue grow. Bounded in
// practice only because each entry read awaits I/O, which lets the reader
// drain. Already-compressed media (image/video/audio/zip/gzip) is STORED
// rather than re-deflated to keep CPU flat on large binaries.

import { Zip, ZipPassThrough, ZipDeflate } from "fflate";
import {
  serveGeneratedAsset,
  GeneratedAssetNotFoundError,
  GeneratedAssetForbiddenError,
  type AssetServePrincipal,
} from "./generated-asset.serve";
import { logger } from "./logger";

/** One file to include in the archive — from `list_conversation_files` items. */
export interface ArchiveAssetEntry {
  /** Generated-asset public id ("gen_…"). */
  publicId: string;
  /** Human-readable filename (with extension) to use inside the ZIP. */
  name: string;
  /** Asset mime type — drives store-vs-deflate per entry. */
  mimeType: string;
}

/** Mime types that are already entropy-coded — deflating them wastes CPU. */
function isPreCompressed(mimeType: string): boolean {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type === "application/zip" ||
    type === "application/gzip"
  );
}

/**
 * Make `name` unique within the archive: "report.pdf" → "report (1).pdf".
 * ZIP tolerates duplicate entry names but extractors silently clobber them,
 * so two same-named conversation files would come out as one.
 */
export function uniqueZipEntryName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let i = 1; used.has(candidate); i++) {
    const dot = name.lastIndexOf(".");
    candidate =
      dot > 0
        ? `${name.slice(0, dot)} (${i})${name.slice(dot)}`
        : `${name} (${i})`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Build a ZIP of the given generated assets as a byte stream.
 *
 * Per-entry failures that mean "this file is gone / not yours"
 * (GeneratedAssetNotFoundError / GeneratedAssetForbiddenError) skip that entry
 * — an asset deleted between listing and download must not corrupt the whole
 * archive. Any other failure errors the stream, since ZIP bytes already sent
 * for earlier entries cannot be retracted.
 */
export function archiveGeneratedAssets(
  entries: readonly ArchiveAssetEntry[],
  principal: AssetServePrincipal,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Once the controller is closed/errored, late fflate callbacks must not
      // touch it again — enqueue() on a settled controller throws.
      let settled = false;
      const zip = new Zip((err, chunk, final) => {
        if (settled) return;
        if (err) {
          settled = true;
          controller.error(err);
          return;
        }
        controller.enqueue(chunk);
        if (final) {
          settled = true;
          controller.close();
        }
      });

      const usedNames = new Set<string>();
      try {
        for (const entry of entries) {
          let served: Awaited<ReturnType<typeof serveGeneratedAsset>>;
          try {
            served = await serveGeneratedAsset(entry.publicId, principal);
          } catch (err) {
            if (
              err instanceof GeneratedAssetNotFoundError ||
              err instanceof GeneratedAssetForbiddenError
            ) {
              logger.warn(
                { assetId: entry.publicId, surface: principal.surface },
                "asset.archive: skipping unavailable asset",
              );
              continue;
            }
            throw err;
          }

          const entryName = uniqueZipEntryName(entry.name, usedNames);
          const file = isPreCompressed(entry.mimeType)
            ? new ZipPassThrough(entryName)
            : new ZipDeflate(entryName, { level: 6 });
          zip.add(file);

          const reader = served.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) file.push(value);
          }
          file.push(new Uint8Array(0), true);
        }
        zip.end();
      } catch (err) {
        logger.error(
          { surface: principal.surface, err },
          "asset.archive: archive stream failed",
        );
        zip.terminate();
        if (!settled) {
          settled = true;
          controller.error(err);
        }
      }
    },
  });
}
