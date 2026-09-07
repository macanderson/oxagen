#!/usr/bin/env bash
#
# Does the binary we just built actually load in the image we ship it to?
#
# The worker carries a `stella-serve` binary compiled on the deploy runner and
# runs it inside a container image chosen by package-for-node.sh. glibc is
# backward compatible and NOT forward compatible: a binary linked against 2.39
# will not load on 2.36, and fails with `version GLIBC_2.3x not found`.
#
# The image choice was already deliberate about glibc VERSUS musl —
# package-for-node.sh moved the worker off alpine precisely so a glibc-linked
# binary would load. It was never about the glibc VERSION, and the two numbers
# live in different files with nothing tying them together. This is that tie.
#
# Why it matters more here than it would elsewhere: `RUN_ENGINES` is
# `["stella"]`, and the env registry says of STELLA_SERVE_BIN that a missing
# binary "fails the turn, and there is no longer another engine to quietly run
# instead". The failure is also invisible until it is expensive — the sidecar
# pool starts lazily, so the container is healthy, /healthz passes, the worker
# claims queued runs, and every turn dies at first spawn.
#
#   usage: check-glibc-parity.sh <binary> [image]
#
# `image` defaults to the worker image package-for-node.sh actually sets, read
# out of that file rather than repeated here — repeating it is the bug this
# script exists to catch, one level up.
set -euo pipefail

BINARY="${1:?usage: check-glibc-parity.sh <binary> [image]}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGER="$REPO_ROOT/tools/scripts/package-for-node.sh"

fail() { echo "::error::$*" >&2; exit 1; }

[[ -f "$BINARY" ]] || fail "no binary at $BINARY"

# ── The image the worker actually runs in ────────────────────────────────────
if [[ -n "${2:-}" ]]; then
  IMAGE="$2"
else
  [[ -f "$PACKAGER" ]] || fail "cannot find $PACKAGER to read the worker image from"
  IMAGE="$(sed -n 's/^[[:space:]]*WRITE_MANIFEST_IMAGE="\([^"]*\)".*/\1/p' "$PACKAGER" | head -1)"
  [[ -n "$IMAGE" ]] || fail "could not read WRITE_MANIFEST_IMAGE out of $PACKAGER"
fi

# ── What the binary demands ──────────────────────────────────────────────────
# Versioned symbol references appear in the dynamic symbol table as
# `GLIBC_2.34`. The highest one is the floor the runtime has to meet.
if command -v objdump >/dev/null 2>&1; then
  SYMS="$(objdump -T "$BINARY" 2>/dev/null || true)"
elif command -v readelf >/dev/null 2>&1; then
  SYMS="$(readelf --dyn-syms --wide "$BINARY" 2>/dev/null || true)"
else
  fail "neither objdump nor readelf is available; cannot read $BINARY"
fi

REQUIRED="$(printf '%s\n' "$SYMS" | grep -oE 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' | sed 's/^GLIBC_//' | sort -V -u | tail -1 || true)"

if [[ -z "$REQUIRED" ]]; then
  # A static binary, or one with no versioned glibc references, cannot be
  # broken by this skew. Say which, rather than passing silently.
  echo "  $BINARY references no versioned glibc symbols — nothing to compare."
  exit 0
fi

# ── What the image provides ──────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "docker is required to read $IMAGE's glibc"
PROVIDED="$(docker run --rm --entrypoint sh "$IMAGE" -c 'ldd --version 2>&1 | head -1' \
  | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?$' | tail -1 || true)"
[[ -n "$PROVIDED" ]] || fail "could not read glibc version from $IMAGE"

echo "  binary requires glibc <= $REQUIRED   ($BINARY)"
echo "  image  provides  glibc    $PROVIDED  ($IMAGE)"

# sort -V puts the lower version first; if the required version is not the
# lower of the two, the image cannot satisfy it.
LOWEST="$(printf '%s\n%s\n' "$REQUIRED" "$PROVIDED" | sort -V | head -1)"
if [[ "$REQUIRED" != "$PROVIDED" && "$LOWEST" != "$REQUIRED" ]]; then
  fail "$(basename "$BINARY") needs glibc $REQUIRED but $IMAGE provides $PROVIDED. \
It will fail to load at first spawn — and because the sidecar pool starts lazily, \
the container will look healthy while every turn that reaches the engine dies. \
Build the binary against a glibc no newer than the image's (build inside $IMAGE, \
or a matching base), rather than moving the image forward to chase the builder."
fi

echo "  ok — the image satisfies the binary"
