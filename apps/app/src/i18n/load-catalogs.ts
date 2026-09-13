import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  catalogStems,
  type Messages,
  mergeCatalogs,
  parseCatalog,
} from "./catalogs";

/**
 * Read every catalog in `dir` and merge it. Server-side only (node:fs).
 *
 * Synchronous on purpose: under `cacheComponents` a prerender treats a promise
 * that settles in a later macrotask (libuv file I/O) as uncached dynamic data,
 * and the catalogs are part of every page's static shell. The result is
 * memoised by the caller, so this runs once per server process.
 *
 * The `turbopackIgnore` comments keep Turbopack's file tracer from treating a
 * runtime path as "trace the whole project"; next.config.ts's
 * `outputFileTracingIncludes` ships messages/*.json into the standalone output
 * explicitly instead.
 */
export function loadCatalogs(dir: string): Messages {
  const entries = readdirSync(/*turbopackIgnore: true*/ dir, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  return mergeCatalogs(
    catalogStems(entries).map((stem) => [
      stem,
      parseCatalog(
        stem,
        readFileSync(
          /*turbopackIgnore: true*/ path.join(dir, `${stem}.json`),
          "utf8",
        ),
      ),
    ]),
  );
}
