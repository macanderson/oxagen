// The shell's blob seam: the one module in this app that reaches
// `@oxagen/storage`.
//
// A data export's archive is a private object, so the bytes can only be handed
// over by a route that streams them (see `export-download.ts`). That route and
// its handler need an object reader, and §2 gives them nowhere to get one: the
// `app` row admits `server/viewer` and no other `server/*` module, and the
// `features` row admits the viewer, the session and the kernel seams alone. A
// `src/server/blob.ts` would therefore have to widen two layer rows to be
// reachable at all.
//
// So the seam sits inside the feature that needs it, exactly as
// `session-client.ts` holds the shell's browser seam to Better Auth and
// `features/audit/filters.ts` holds Audit's seam to the emitted security event
// types. It exports one narrow read and no adapter, so nothing downstream can
// write, delete or reach a second store through it, and the whole
// `@oxagen/storage` surface stays behind these few lines.
import "server-only";
import { storage } from "@oxagen/storage";

/** What the download route needs of a stored object: the bytes and their type. */
export type ExportObject = {
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
};

/** Stream one private export archive by the key the capability reported. */
export async function readExportObject(key: string): Promise<ExportObject> {
  const object = await storage().get(key);
  return { body: object.body, contentType: object.contentType };
}
