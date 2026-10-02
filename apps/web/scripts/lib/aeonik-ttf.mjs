// The TTF the generated images draw their text from, and the stamp that ties
// it to the WOFF2 the site serves (#5237).
//
// text.mjs reads scripts/fonts/aeonik-wght.ttf, which is the site's
// fonts/aeonik-wght.woff2 unpacked to a TTF, because fontkit 2.0.4 can't make
// a weight instance from a WOFF2. The brand sync rewrites the WOFF2 when the
// kit's Aeonik changes, and it never touches the TTF. So the unpack writes a
// stamp beside the TTF: the sha256 of the WOFF2 it read and of the TTF it
// wrote, one `<sha256>  <path>` line each, the form `shasum -a 256` prints.
// `node apps/web/scripts/unpack-aeonik.mjs --check` compares the stamp with
// both files, and CI runs that check in `pnpm check:contracts`.

import { createHash } from "node:crypto";

/** The WOFF2 the site serves, which the brand sync copies from the kit. */
export const WOFF2 = "apps/web/fonts/aeonik-wght.woff2";
/** The TTF text.mjs reads. */
export const TTF = "apps/web/scripts/fonts/aeonik-wght.ttf";
/** The stamp: which WOFF2 the TTF came from, and which TTF the unpack wrote. */
export const STAMP = "apps/web/scripts/fonts/aeonik-wght.sha256";
/** The one command that unpacks the WOFF2 again and rewrites the stamp. */
export const UNPACK = "node apps/web/scripts/unpack-aeonik.mjs";

const LINE = /^([0-9a-f]{64}) [ *]?(\S+)$/;

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The stamp for a TTF unpacked from a WOFF2.
 * @param {Uint8Array} woff2
 * @param {Uint8Array} ttf
 * @returns {string}
 */
export function aeonikStamp(woff2, ttf) {
  return `${sha256(woff2)}  ${WOFF2}\n${sha256(ttf)}  ${TTF}\n`;
}

/**
 * Why the TTF is not the unpack of the WOFF2 the site serves, or null when it
 * is. Each argument holds a file's contents, or null when the file is missing.
 * @param {string | null} stamp
 * @param {Uint8Array | null} woff2
 * @param {Uint8Array | null} ttf
 * @returns {string | null}
 */
export function aeonikDrift(stamp, woff2, ttf) {
  if (woff2 === null) return `${WOFF2} is missing`;
  if (ttf === null) return `${TTF} is missing`;
  if (stamp === null) {
    return `${STAMP} is missing, so nothing records which WOFF2 the TTF came from`;
  }
  const hashes = new Map();
  for (const line of stamp.trim().split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) return `${STAMP} has a line that is not "<sha256>  <path>"`;
    hashes.set(m[2], m[1]);
  }
  if (hashes.get(WOFF2) !== sha256(woff2)) {
    return `${WOFF2} changed after the TTF was unpacked from it`;
  }
  if (hashes.get(TTF) !== sha256(ttf)) {
    return `${TTF} changed after the unpack wrote it`;
  }
  return null;
}
