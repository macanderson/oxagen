# ---------------------------------------------------------------------------
# downloads.oxagen.sh — the desktop installers and their checksums
# ---------------------------------------------------------------------------
#
# Every installer `.github/workflows/desktop.yml` builds (`.dmg` for both Mac
# architectures, `.deb` / `.rpm` / `.AppImage`, `.msi` / NSIS `.exe`) is laid
# out as `desktop/<version>/<file>` next to a `SHA256SUMS.txt`, with an
# `index.html` at the root listing the current version. The same static-site
# module the marketing site uses: a private bucket reached only through an
# Origin Access Control, security headers, and TLS on the branded hostname.
# A download is a file with an extension, so the rewrite function passes it
# through untouched.
#
# The bucket predates this stack: 2.1.1 was published to it by hand on
# 2026-09-14 with a public-read policy on `desktop/*` so the first links could
# go out before this distribution existed. Adopting it keeps those objects;
# the module's public access block and OAC-only policy replace the public
# policy, so `oxagen-downloads-916294258235.s3.amazonaws.com` links stop
# resolving on apply and `https://downloads.oxagen.sh/desktop/...` takes
# their place. The block is a no-op once the bucket is in state.
import {
  to = module.downloads.aws_s3_bucket.site
  id = "oxagen-downloads-${var.account_id}"
}

module "downloads" {
  source = "../../modules/static-site"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name             = "oxagen-downloads"
  bucket_name      = "oxagen-downloads-${var.account_id}"
  domain_name      = "downloads.oxagen.sh"
  hosted_zone_id   = aws_route53_zone.oxagen_sh.zone_id
  url_rewrite_mode = "directory_index"
  # A path that matches no object lands on the listing rather than a bare
  # 404, which is where someone who mistyped a version wants to be.
  not_found_path = "/index.html"
  # A published version never changes: `desktop/2.1.1/…` is cut once and a
  # fix ships as a new version, so those objects can be cached for a year.
  immutable_path_patterns = ["/desktop/*"]

  tags = { Brand = local.brand }
}
