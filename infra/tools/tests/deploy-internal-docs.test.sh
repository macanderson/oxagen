#!/usr/bin/env bash
#
# Holds the internal docs deploy to what keeps the site up and private.
#
# The deploy itself needs the live account, so what a test can hold is what the
# script stages, how it judges the post-deploy probes, and the agreement between
# the four files that must name the same host and port. Nothing else enforces
# that agreement: a port mismatch is a 502, a host missing from the certificate
# is a TLS error, and a Caddyfile that lost its password check is a public site
# holding the pricing and plans.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd)
INFRA=$(cd "$TOOLS/.." && pwd)

# shellcheck source=infra/tools/deploy-internal-docs.sh
source "$TOOLS/deploy-internal-docs.sh"

FAILED=0
CASES=0
pass() { CASES=$((CASES + 1)); }
fail() {
  CASES=$((CASES + 1))
  FAILED=$((FAILED + 1))
  echo "FAIL: $1" >&2
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
CADDYFILE="$TOOLS/internal-docs/Caddyfile"

# --- staging refuses what looks like a failed build -----------------------

stage_internal_docs "$WORK/does-not-exist" "$WORK/o1" "$CADDYFILE" 2>/dev/null \
  && fail "a missing export directory is refused" || pass

mkdir -p "$WORK/no-index"
echo x > "$WORK/no-index/a.html"
echo y > "$WORK/no-index/b.html"
stage_internal_docs "$WORK/no-index" "$WORK/o2" "$CADDYFILE" 2>/dev/null \
  && fail "an export with no index.html is refused" || pass

mkdir -p "$WORK/one-file"
echo x > "$WORK/one-file/index.html"
stage_internal_docs "$WORK/one-file" "$WORK/o3" "$CADDYFILE" 2>/dev/null \
  && fail "an export of a single file is refused" || pass

mkdir -p "$WORK/ok/docs"
echo home > "$WORK/ok/index.html"
echo page > "$WORK/ok/docs/pricing.html"
stage_internal_docs "$WORK/ok" "$WORK/o4" "$WORK/no-such-Caddyfile" 2>/dev/null \
  && fail "a missing Caddyfile is refused" || pass

# --- a good export stages into the shape deploy-service.sh reads ----------

if stage_internal_docs "$WORK/ok" "$WORK/staged" "$CADDYFILE"; then
  pass
  [[ -f $WORK/staged/site/index.html && -f $WORK/staged/site/docs/pricing.html ]] && pass \
    || fail "the export lands under site/, nested paths intact"
  cmp -s "$WORK/staged/Caddyfile" "$CADDYFILE" && pass \
    || fail "the site's Caddyfile ships at the artifact root"

  m="$WORK/staged/oxagen-run.json"
  [[ $(jq -r .port "$m") == 3003 ]] && pass || fail "manifest port is 3003"
  [[ $(jq -r .image "$m") == caddy:2 ]] && pass || fail "manifest image is caddy:2"
  [[ $(jq -r .health_path "$m") == /healthz ]] && pass || fail "manifest health path is /healthz"
  [[ $(jq -c .command "$m") == '["caddy","run","--config","/app/Caddyfile","--adapter","caddyfile"]' ]] && pass \
    || fail "manifest command runs the shipped Caddyfile"
  [[ $(jq -r .config_prefix "$m") == /oxagen/production/internal-docs ]] && pass \
    || fail "manifest reads the hash from the site's own prefix"
  [[ $(jq -r 'has("env")' "$m") == false ]] && pass \
    || fail "manifest carries no static env (it would ship in the tarball)"
else
  fail "a two-file export with index.html stages"
fi

# --- the tarball carries no macOS metadata --------------------------------
#
# GNU tar on the node prints a warning per file for every LIBARCHIVE.xattr
# header a Mac's bsdtar writes, and extracts an AppleDouble ._ file beside
# each file that had metadata. Neither belongs in the artifact.

mkdir -p "$WORK/pack/site"
echo home > "$WORK/pack/site/index.html"
echo '{}' > "$WORK/pack/oxagen-run.json"
cp "$CADDYFILE" "$WORK/pack/Caddyfile"
# Give the files attributes where the platform can, so the real-tar cases
# below test something on a Mac; elsewhere they hold the archive's shape.
if command -v xattr >/dev/null 2>&1; then
  xattr -w com.apple.provenance x "$WORK/pack/site/index.html" 2>/dev/null
  xattr -w com.oxagen.test 1 "$WORK/pack/Caddyfile" 2>/dev/null
elif command -v setfattr >/dev/null 2>&1; then
  setfattr -n user.oxagen.test -v 1 "$WORK/pack/site/index.html" 2>/dev/null
fi

if pack_internal_docs "$WORK/pack" "$WORK/pack.tgz"; then
  pass
  listing=$(tar -tzf "$WORK/pack.tgz")
  [[ $listing == *site/index.html* && $listing == *Caddyfile* && $listing == *oxagen-run.json* ]] && pass \
    || fail "the tarball holds site/, the Caddyfile and the manifest"
  printf '%s\n' "$listing" | command grep -q '\._' && fail "the tarball holds no AppleDouble ._ files" || pass
  gzip -dc "$WORK/pack.tgz" | LC_ALL=C command grep -aqE 'LIBARCHIVE\.xattr|SCHILY\.xattr' \
    && fail "the tarball carries no extended-attribute headers" || pass
else
  fail "a staged directory packs"
fi

# Stand-in tars that log each call as "<COPYFILE_DISABLE>|<argv>", so the
# flags are held on every platform, whatever tar the machine has.
mkdir -p "$WORK/tar-new" "$WORK/tar-old"
cat > "$WORK/tar-new/tar" <<'SH'
#!/usr/bin/env bash
printf '%s|%s\n' "${COPYFILE_DISABLE:-}" "$*" >> "$TARLOG"
SH
cat > "$WORK/tar-old/tar" <<'SH'
#!/usr/bin/env bash
if [[ " $* " == *" --no-xattrs "* ]]; then
  echo "tar: unrecognized option '--no-xattrs'" >&2
  exit 64
fi
printf '%s|%s\n' "${COPYFILE_DISABLE:-}" "$*" >> "$TARLOG"
SH
chmod +x "$WORK/tar-new/tar" "$WORK/tar-old/tar"

packed_with() {
  export TARLOG="$WORK/$1.log"
  : > "$TARLOG"
  (PATH="$WORK/$1:$PATH" pack_internal_docs "$WORK/pack" "$WORK/$1.tgz") || return 1
  command grep -- '-czf' "$TARLOG"
}

call=$(packed_with tar-new) && pass || fail "packing succeeds with a tar that takes --no-xattrs"
[[ $call == "1|--no-xattrs -czf $WORK/tar-new.tgz -C $WORK/pack ." ]] && pass \
  || fail "a tar that takes --no-xattrs gets it, with COPYFILE_DISABLE=1 (got: $call)"

call=$(packed_with tar-old) && pass || fail "packing succeeds with a tar that refuses --no-xattrs"
[[ $call == "1|-czf $WORK/tar-old.tgz -C $WORK/pack ." ]] && pass \
  || fail "a tar that refuses --no-xattrs packs without it, still with COPYFILE_DISABLE=1 (got: $call)"

# The deploy must pack through the function, not a bare tar that skips both.
! command grep -qE '^[[:space:]]*tar[[:space:]]' "$TOOLS/deploy-internal-docs.sh" \
  && command grep -q '^pack_internal_docs "\$STAGE" "\$TARBALL"$' "$TOOLS/deploy-internal-docs.sh" && pass \
  || fail "the deploy builds its tarball only through pack_internal_docs"

# --- the post-deploy verdict ----------------------------------------------

internal_docs_verdict 401 200 200 200 >/dev/null && pass \
  || fail "401 anonymous, 200 with password, app and api up is a pass"
internal_docs_verdict 200 200 200 200 >/dev/null && fail "a site answering 200 without a password fails" || pass
internal_docs_verdict 401 401 200 200 >/dev/null && fail "a password that does not work fails" || pass
internal_docs_verdict 401 200 502 200 >/dev/null && fail "app.oxagen.sh down after the deploy fails" || pass
internal_docs_verdict 401 200 200 000 >/dev/null && fail "api.oxagen.sh unreachable after the deploy fails" || pass

# --- the site's Caddyfile keeps the site private ---------------------------

site=$(cat "$CADDYFILE")
# First line whose directive (not a comment that mentions it) matches.
line_of() { command grep -n -m1 -E -- "^[[:space:]]*$1" "$CADDYFILE" | cut -d: -f1; }

[[ $site == *'admin off'* ]] && pass \
  || fail "the site's Caddy disables its admin API (it shares the host network with the front door's)"
[[ $site == *'{$INTERNAL_DOCS_PASSWORD_HASH}'* ]] && pass \
  || fail "basic_auth reads the hash from the environment, not a literal"
command grep -Eq '\$2[aby]\$' "$CADDYFILE" && fail "no bcrypt hash is committed in the Caddyfile" || pass
[[ $site == *'X-Robots-Tag "noindex, nofollow"'* ]] && pass || fail "the site sends noindex"
[[ $site == *'try_files {path} {path}.html {path}/index.html'* ]] && pass \
  || fail "try_files serves both trailingSlash layouts of a static export"

healthz=$(line_of 'respond /healthz 200$')
auth=$(line_of 'basic_auth \{$')
files=$(line_of 'file_server$')
if [[ -n $healthz && -n $auth && -n $files ]] && (( healthz < auth && auth < files )); then
  pass
else
  fail "inside the route: /healthz, then basic_auth, then file_server (got $healthz, $auth, $files)"
fi
[[ $(command grep -cE '^[[:space:]]*file_server$' "$CADDYFILE") -eq 2 ]] && pass \
  || fail "file_server appears only after the password check and in the 404 handler"

# --- the four files agree on host and port ---------------------------------

front=$(cat "$TOOLS/caddy/Caddyfile.alb")
[[ $front == *"@internal host $INTERNAL_DOCS_HOST"* ]] && pass \
  || fail "Caddyfile.alb routes $INTERNAL_DOCS_HOST"
block=$(awk '/handle @internal \{/,/\}/' "$TOOLS/caddy/Caddyfile.alb")
[[ $block == *"reverse_proxy 127.0.0.1:$INTERNAL_DOCS_PORT"* ]] && pass \
  || fail "Caddyfile.alb proxies $INTERNAL_DOCS_HOST to port $INTERNAL_DOCS_PORT"
[[ $(jq -r .port "$WORK/staged/oxagen-run.json" 2>/dev/null) == "$INTERNAL_DOCS_PORT" ]] && pass \
  || fail "the manifest port matches INTERNAL_DOCS_PORT"

main_tf="$INFRA/stacks-new/oxagen/main.tf"
cert=$(awk '/resource "aws_acm_certificate" "app"/,/^}/' "$main_tf")
[[ $cert == *"\"$INTERNAL_DOCS_HOST\""* ]] && pass \
  || fail "the ALB certificate covers $INTERNAL_DOCS_HOST"
services=$(awk '/node_services = toset\(\[/,/\]\)/' "$main_tf")
[[ $services == *"\"$INTERNAL_DOCS_HOST\""* ]] && pass \
  || fail "local.node_services creates the $INTERNAL_DOCS_HOST record"

# Taken outside package-for-node.sh, so that script must not hand it out.
command grep -Eq "^\s+[a-z-]+\)\s+echo $INTERNAL_DOCS_PORT ;;" "$INFRA/../tools/scripts/package-for-node.sh" \
  && fail "package-for-node.sh assigns port $INTERNAL_DOCS_PORT to another service" || pass

# The plaintext password must not sit where app, api and mcp load recursively.
[[ $INTERNAL_DOCS_PASSWORD_PARAM != /oxagen/production/* ]] && pass \
  || fail "the plaintext password is outside /oxagen/production"

if [[ $FAILED -gt 0 ]]; then
  echo "deploy-internal-docs: $FAILED of $CASES cases failed" >&2
  exit 1
fi
echo "deploy-internal-docs: $CASES cases passed"
