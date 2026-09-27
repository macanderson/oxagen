/**
 * The variable that holds the deployment's attester key (ADR-195).
 *
 * A seal signs its run attestation with this key, and `export_run` signs the
 * export bundle with it. Both read the name from here, so a rename cannot
 * leave one of them reading a variable nobody sets. The module imports
 * nothing, so a caller can take the name without loading the run store.
 */
export const ATTESTER_KEY_ENV = "TACHO_BUNDLE_SIGNING_PRIVATE_KEY";
