#!/usr/bin/env bash
# Starts a built macOS bundle's binaries under the hardened runtime, with the
# entitlements the bundle carries (#3214).
#
#   bash apps/desktop/scripts/smoke-macos-bundle.sh <Oxagen.app> <entitlements.plist>
#
# 1. Prints each binary's signature and entitlements.
# 2. Runs `tacho --version` and `oxagen --version` from inside the bundle. A
#    Node single-executable reserves its V8 CodeRange at startup, so this is
#    the start that failed before #3208 added the JIT entitlements.
# 3. Starts the app itself and checks it is still running 20 seconds later.
#
# A binary signed without the hardened runtime is not held to library
# validation, so a pass would prove nothing. When any of the three lacks the
# `runtime` flag, the script copies the bundle and re-signs the copy ad hoc
# with `--options runtime` and the given plist, then checks the copy.
#
# Every command runs with HOME pointed at a scratch directory, so the app's
# PATH install and state reads touch nothing of the machine's own. Run it on a
# CI runner, not on a machine with a live enrollment.
set -euo pipefail

usage="usage: smoke-macos-bundle.sh <Oxagen.app> <entitlements.plist>"
app="${1:?$usage}"
plist="${2:?$usage}"
seconds=20
scratch="$(mktemp -d)"
home="$scratch/home"
mkdir -p "$home"

executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
binaries=("$executable" tacho oxagen)

# The CodeDirectory flags, for example 0x10002(adhoc,runtime).
flags() {
  { codesign -dv "$1" 2>&1 || true; } | sed -n 's/^CodeDirectory .*flags=\([^ ]*\).*/\1/p'
}

# Run a command, killing it after $1 seconds.
bounded() {
  perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' "$@"
}

hardened=true
for bin in "${binaries[@]}"; do
  case "$(flags "$app/Contents/MacOS/$bin")" in
    *runtime*) ;;
    *) hardened=false ;;
  esac
done

target="$app"
if [ "$hardened" = true ]; then
  echo "Every binary in $app is signed with the hardened runtime."
else
  target="$scratch/$(basename "$app")"
  echo "$app has a binary signed without the hardened runtime."
  echo "Checking a copy re-signed ad hoc with --options runtime and $plist: $target"
  cp -R "$app" "$target"
  for bin in tacho oxagen; do
    codesign --force --options runtime --entitlements "$plist" -s - "$target/Contents/MacOS/$bin"
  done
  codesign --force --options runtime --entitlements "$plist" -s - "$target"
  # The re-sign proves nothing unless every binary now carries the flag.
  for bin in "${binaries[@]}"; do
    now="$(flags "$target/Contents/MacOS/$bin")"
    echo "$bin in the copy: flags=$now"
    case "$now" in
      *runtime*) ;;
      *)
        echo "::error::$bin in the re-signed copy still lacks the hardened runtime (flags=$now)"
        exit 1
        ;;
    esac
  done
fi

echo
echo "== Signatures"
codesign --verify --deep --strict --verbose=2 "$target"
for bin in "${binaries[@]}"; do
  echo
  echo "-- $bin"
  codesign -dv --verbose=2 "$target/Contents/MacOS/$bin" 2>&1
  if codesign -d --entitlements - --xml "$target/Contents/MacOS/$bin" > "$scratch/$bin.entitlements" 2>/dev/null &&
    [ -s "$scratch/$bin.entitlements" ]; then
    plutil -p "$scratch/$bin.entitlements"
  else
    echo "(no entitlements)"
  fi
done

status=0

echo
echo "== Sidecars"
for bin in tacho oxagen; do
  if out="$(HOME="$home" bounded 60 "$target/Contents/MacOS/$bin" --version 2>&1)"; then
    echo "$bin --version: $out"
  else
    code=$?
    echo "$out"
    echo "::error::$bin --version exited $code from the signed bundle"
    status=1
  fi
done

echo
echo "== App, for $seconds seconds"
HOME="$home" "$target/Contents/MacOS/$executable" > "$scratch/app.log" 2>&1 &
pid=$!
sleep "$seconds"
if kill -0 "$pid" 2>/dev/null; then
  echo "$executable is still running after $seconds seconds."
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
else
  code=0
  wait "$pid" || code=$?
  echo "::error::$executable exited $code within $seconds seconds"
  status=1
fi
echo "-- app output"
cat "$scratch/app.log"

echo
echo "== Library validation messages in the system log, last five minutes"
log show --last 5m --style compact \
  --predicate 'eventMessage CONTAINS[c] "library validation"' 2>/dev/null | tail -n 20 || true

exit "$status"
