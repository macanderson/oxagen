#!/usr/bin/env bash
#
# Turn an OpenNext build into the two artifacts the nextjs-site module needs:
# a zipped server function, and the assets that belong in the origin bucket.
#
#   tools/package-nextjs.sh <app-dir> [out-dir]
#
# Run the app's own `open-next build` first; this only packages what that
# produced. It prints the zip path and its base64 SHA-256, which are the
# `bundle_path` and `bundle_hash` variables the module takes.

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <app-dir> [out-dir]" >&2
  exit 2
fi

APP_DIR=$(cd "$1" && pwd)
OUT_DIR=${2:-$APP_DIR/.open-next/_package}
OPEN_NEXT="$APP_DIR/.open-next"
SERVER="$OPEN_NEXT/server-functions/default"

if [[ ! -d $SERVER ]]; then
  echo "error: no OpenNext server function at $SERVER" >&2
  echo "       run 'open-next build' in $APP_DIR first" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/server.zip"
rm -f "$ZIP"

# ---------------------------------------------------------------------------
# Repair incompletely-traced packages
# ---------------------------------------------------------------------------
#
# Next builds the bundle by static analysis: it follows `require` and `import`
# and copies what it finds. A package whose files are addressed by a path
# assembled at runtime is invisible to that analysis, so its `package.json`
# gets copied — something did reference the package — while the code does not.
#
# `@swc/helpers` is the reliable example. Next's compiled output reaches into
# it as `@swc/helpers/_/_interop_require_default`, resolved through the
# package's `exports` map at runtime, and the bundle ends up holding a lone
# `package.json`. Nothing fails until a cold start, where it surfaces as
# `Cannot find module '/var/task/node_modules/@swc/helpers/cjs/...'` — a
# message that names a file rather than the reason it is absent.
#
# The repair is deliberately shaped as a general rule rather than a fix for
# that one package: any bundled package directory holding nothing but a
# `package.json` was traced incompletely, so the whole package is recopied from
# the source tree. Packages that legitimately ship only a manifest do exist,
# and recopying one is a no-op.
BUNDLE_MODULES="$SERVER/node_modules"
SOURCE_MODULES="$APP_DIR/node_modules"
repaired=0

if [[ -d $BUNDLE_MODULES && -d $SOURCE_MODULES ]]; then
  while IFS= read -r manifest; do
    pkg_dir=$(dirname "$manifest")
    # Only a package.json and nothing beside it.
    if [[ $(find "$pkg_dir" -mindepth 1 -maxdepth 1 | wc -l) -ne 1 ]]; then
      continue
    fi

    rel=${pkg_dir#"$BUNDLE_MODULES"/}
    src="$SOURCE_MODULES/$rel"
    [[ -d $src ]] || continue

    # -L dereferences symlinks, which is the point: the source tree may reach
    # the real package through one, and a symlink copied into a zip is a
    # dangling path once unpacked into /var/task.
    rm -rf "$pkg_dir"
    cp -RL "$src" "$pkg_dir"
    echo "    repaired incompletely-traced package: $rel" >&2
    repaired=$((repaired + 1))
  done < <(find "$BUNDLE_MODULES" -name package.json -maxdepth 3 -type f)
fi

if (( repaired > 0 )); then
  echo "    $repaired package(s) recopied from $SOURCE_MODULES" >&2
fi

# Zipped from inside the function directory so that `index.mjs` sits at the
# root of the archive — Lambda resolves the handler relative to the archive
# root, and a bundle nested one directory down fails at import with a message
# that names the handler rather than the layout.
#
# `-X` drops extra file attributes (uid/gid, timestamps beyond the DOS field),
# which is what lets the same input produce the same bytes on two machines. A
# hash that changes because the builder changed would redeploy the function on
# every apply.
(cd "$SERVER" && zip -qr -X "$ZIP" .)

HASH=$(openssl dgst -binary -sha256 "$ZIP" | openssl base64)
SIZE=$(du -h "$ZIP" | cut -f1)

echo "bundle_path = \"$ZIP\""
echo "bundle_hash = \"$HASH\""
echo "# $SIZE" >&2

# Lambda refuses a package over 50 MB uploaded from S3 as a zip, and the
# unzipped size must stay under 250 MB. Failing here names the real limit;
# failing at apply time surfaces as an opaque InvalidParameterValueException.
BYTES=$(wc -c < "$ZIP")
if (( BYTES > 50 * 1024 * 1024 )); then
  echo "error: bundle is $SIZE, over Lambda's 50 MB limit for an S3 zip" >&2
  exit 1
fi
