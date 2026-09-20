#!/usr/bin/env bash
# Point the desktop updater feed at release $TAG.
#
# The installed app polls the `desktop-latest` release's latest.json (the
# endpoint in apps/desktop/src-tauri/tauri.conf.json), so this copies the
# just-published release's latest.json there. Its platform URLs point at the
# versioned release's assets, which stay put. A release built without the
# updater key carries no latest.json and leaves the feed as it was.
#
# Needs GH_TOKEN, TAG and GITHUB_REPOSITORY. Run by .github/workflows/desktop.yml
# from the `publish` job (a tagged build) and the `feed` job (a release a
# person published).
set -euo pipefail

tmp="$(mktemp -d)"
if ! gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --pattern latest.json --dir "$tmp"; then
  echo "::notice::$TAG carries no latest.json (built without TAURI_SIGNING_PRIVATE_KEY); the update feed is unchanged."
  exit 0
fi
if ! gh release view desktop-latest --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  gh release create desktop-latest --repo "$GITHUB_REPOSITORY" \
    --title "Oxagen desktop update feed" \
    --notes "latest.json for the in-app updater; the app itself is on the desktop-v* releases. Rewritten by desktop.yml when one is published." \
    --latest=false
fi
# Never move the feed backwards. Publishing an older draft after a newer
# release used to clobber the feed with the older latest.json, and every
# installed app then saw "up to date" on an old version.
next="$(jq -r .version "$tmp/latest.json")"
mkdir "$tmp/current"
if gh release download desktop-latest --repo "$GITHUB_REPOSITORY" --pattern latest.json --dir "$tmp/current" 2>/dev/null; then
  current="$(jq -r .version "$tmp/current/latest.json")"
  newest="$(printf '%s\n%s\n' "$current" "$next" | sort -V | tail -n 1)"
  if [ "$current" = "$next" ] || [ "$newest" != "$next" ]; then
    echo "::notice::the feed already serves $current, which is not older than $TAG ($next); left as it is."
    exit 0
  fi
fi
gh release upload desktop-latest "$tmp/latest.json" --repo "$GITHUB_REPOSITORY" --clobber
echo "::notice::desktop-latest now serves $TAG's latest.json."
