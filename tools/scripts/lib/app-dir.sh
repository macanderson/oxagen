# The directory that ships as the `app` service, for shell callers.
#
# Sourced by package-for-node.sh. The rebuild's app-dir.mjs is the one source
# the parity gates read (implementation plan §6 Q2); while it is on the tree
# the deploy follows it, and without it apps/app is the one app there is.
# Run from the repository root.
resolve_app_dir() {
  if [[ -f tools/scripts/lib/app-dir.mjs ]]; then
    node --input-type=module -e \
      'import { APP_DIR } from "./tools/scripts/lib/app-dir.mjs"; process.stdout.write(APP_DIR)'
  else
    printf 'apps/app'
  fi
}
