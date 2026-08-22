#!/usr/bin/env bash
#
# Upload a built static site to its S3 origin and invalidate the CDN in front
# of it.
#
#   tools/deploy-static.sh <build-dir> <bucket> <distribution-id>
#
# The upload happens in two passes because the two kinds of file want opposite
# caching, and getting it wrong is either a stale site or a pointless bill:
#
#   Fingerprinted assets (/_next/static/**, and anything else whose name
#   changes when its bytes change) are immutable. They are uploaded first and
#   cached for a year, so a browser that already has one never asks again.
#
#   Everything else — chiefly HTML — is uploaded second with `no-cache`, which
#   does not mean "do not store" but "revalidate before use". The CDN still
#   serves it from the edge; it just checks first, so a deploy is visible
#   immediately rather than whenever a TTL happens to lapse.
#
# The order is deliberate. Assets go up before the HTML that references them,
# so there is no window in which a freshly-served page asks for a chunk that
# has not been uploaded yet — the failure that makes a deploy look like a
# broken site for the few seconds it lasts.

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <build-dir> <bucket> <distribution-id>" >&2
  exit 2
fi

BUILD_DIR=$1
BUCKET=$2
DISTRIBUTION=$3

if [[ ! -d $BUILD_DIR ]]; then
  echo "error: build directory '$BUILD_DIR' does not exist — run the site's build first" >&2
  exit 1
fi

# Guard against uploading an empty directory over a working site. A build that
# failed quietly leaves its output directory present but bare, and `s3 sync
# --delete` would faithfully replicate that emptiness to production.
file_count=$(find "$BUILD_DIR" -type f | wc -l | tr -d ' ')
if [[ $file_count -lt 2 ]]; then
  echo "error: '$BUILD_DIR' holds $file_count files — refusing to publish what looks like a failed build" >&2
  exit 1
fi

echo "==> $file_count files from $BUILD_DIR -> s3://$BUCKET"

# Pass 1: immutable, fingerprinted assets.
if [[ -d "$BUILD_DIR/_next/static" ]]; then
  aws s3 sync "$BUILD_DIR/_next/static" "s3://$BUCKET/_next/static" \
    --cache-control "public, max-age=31536000, immutable" \
    --only-show-errors
  echo "    fingerprinted assets uploaded"
fi

# Pass 2: everything else, revalidated on use.
#
# `--delete` prunes objects the build no longer produces, which is what keeps a
# deleted page from being served indefinitely by the CDN. `_next/static` is
# excluded from the delete sweep as well as the upload: the previous build's
# chunks must outlive this deploy, or a browser mid-navigation loses the file
# it was about to request.
# Some of these sites are published straight out of a source directory rather
# than a build output directory, so the sweep has to leave behind the things
# that live beside a site without being part of it. `.vercel/project.json` in
# particular carries project and organisation identifiers, and a bucket fronted
# by a CDN is a public place to leave them.
aws s3 sync "$BUILD_DIR" "s3://$BUCKET" \
  --exclude "_next/static/*" \
  --exclude ".vercel/*" \
  --exclude ".git/*" \
  --exclude "node_modules/*" \
  --exclude "package.json" \
  --exclude "package-lock.json" \
  --exclude "pnpm-lock.yaml" \
  --exclude "*.log" \
  --exclude "README.md" \
  --exclude ".gitignore" \
  --exclude ".env*" \
  --cache-control "public, no-cache, must-revalidate" \
  --delete \
  --only-show-errors
echo "    documents uploaded"

# A distribution id of "-" means there is no CDN in front of this bucket yet.
# That is the normal state during a migration: content is staged into the
# origin before the certificate validates and the distribution exists, so that
# the site is complete the moment DNS points at it.
if [[ $DISTRIBUTION == "-" ]]; then
  echo "==> no distribution yet; skipping invalidation"
  exit 0
fi

# Only the mutable half needs invalidating; the immutable half cannot go stale
# by construction. CloudFront gives 1,000 free invalidation paths a month and
# charges beyond that, so this asks for the two patterns that matter rather
# than a blanket "/*".
invalidation=$(aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION" \
  --paths "/" "/*" \
  --query 'Invalidation.Id' \
  --output text)
echo "==> invalidation $invalidation created on $DISTRIBUTION"
