// The web app directory the path-keyed parity gates read: check_ui_parity
// (capability-ui-map.json, its baseline, and the invoke() scan of src/),
// check_mobile_parity (mobile-parity.json and the src/ scan) and check_manifest
// (the per-capability `e2e` layer).
//
// During the Mission Control rebuild the gates keep pointing at the deprecated
// app, whose bindings, manifests and per-capability e2e specs are the ones that
// exist (implementation plan §6 Q2). The cutover batch flips this to "apps/app"
// in the same PR that commits the new app's capability-ui-map.json,
// mobile-parity.json and regenerated baseline.
export const APP_DIR = "apps/app_deprecated";
