#!/usr/bin/env node
// Unpack the site's Aeonik WOFF2 into the TTF the generated images draw their
// text from, or check that the committed TTF is still that unpack (#5237).
//
//   node apps/web/scripts/unpack-aeonik.mjs [--check]
//
// With no flag, the script unpacks apps/web/fonts/aeonik-wght.woff2 with
// fontTools into apps/web/scripts/fonts/aeonik-wght.ttf, then writes the stamp
// beside the TTF (lib/aeonik-ttf.mjs says what the stamp holds). The unpack
// runs the first python3 on PATH, which needs the fonttools and brotli packages
// (`pip install fonttools brotli`). To use a virtual environment that has them,
// activate it first. The TTF keeps the WOFF2's modified date, so a second run on
// the same WOFF2 writes the same bytes.
//
// With --check, the script writes nothing and needs Node alone. It exits 1 when
// the stamp does not match both files, and it names the command to run. CI runs
// it in `pnpm check:contracts`, in the checks job.
//
// The brand sync (tools/scripts/sync-brand-assets.mjs) doesn't run this script.
// The sync needs Node alone, and the kit's fan-out workflow installs no
// fontTools. So when a sync changes the WOFF2, its pull request fails the check
// until someone runs this script on that branch and commits both files.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STAMP,
  TTF,
  UNPACK,
  WOFF2,
  aeonikDrift,
  aeonikStamp,
} from "./lib/aeonik-ttf.mjs";

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const abs = (rel) => path.join(REPO, rel);

/** A repo file's bytes, or null when it is missing. */
function read(rel) {
  try {
    return readFileSync(abs(rel));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// fontTools reads a WOFF2 through brotli, and it raises ImportError when either
// package is missing. recalcTimestamp=False keeps head.modified from the WOFF2.
const UNPACK_PY = `
import sys
try:
    from fontTools.ttLib import TTFont
    font = TTFont(sys.argv[1], recalcTimestamp=False)
except ImportError as error:
    sys.exit(f"{error}. Install the packages with: pip install fonttools brotli")
font.flavor = None
font.save(sys.argv[2])
`;

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  // A mistyped flag must not fall through to the unpack and rewrite the TTF.
  console.error(`aeonik-ttf: unknown arguments: ${args.join(" ")}`);
  console.error(`usage: ${UNPACK} [--check]`);
  process.exit(2);
}

if (args[0] === "--check") {
  const reason = aeonikDrift(
    read(STAMP)?.toString("utf8") ?? null,
    read(WOFF2),
    read(TTF),
  );
  if (reason) {
    console.error(`aeonik-ttf: ${TTF} is out of step with ${WOFF2}: ${reason}.`);
    console.error(
      `Run ${UNPACK} and commit the TTF and ${STAMP}. ` +
        "The unpack needs Python 3 with fontTools: pip install fonttools brotli. " +
        "Don't write the stamp by hand: it would pass a TTF that no unpack made.",
    );
    process.exit(1);
  }
  console.log(`aeonik-ttf: ${TTF} is the unpack of ${WOFF2}`);
} else {
  const run = spawnSync("python3", ["-c", UNPACK_PY, abs(WOFF2), abs(TTF)], {
    stdio: "inherit",
  });
  if (run.error || run.status !== 0) {
    console.error(
      `aeonik-ttf: FAILED. python3 could not unpack ${WOFF2}, so the TTF and ` +
        "the stamp are unchanged. " +
        (run.error
          ? `python3 did not start (${run.error.message}). `
          : "The error above says why. ") +
        "The unpack needs Python 3 with fontTools: pip install fonttools brotli. " +
        "To use a virtual environment that has them, activate it and run this again.",
    );
    process.exit(2);
  }
  writeFileSync(abs(STAMP), aeonikStamp(read(WOFF2), read(TTF)));
  console.log(`aeonik-ttf: wrote ${TTF} and ${STAMP} from ${WOFF2}`);
}
