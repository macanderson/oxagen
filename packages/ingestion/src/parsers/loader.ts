/**
 * Re-exports from @oxagen/code-graph — the canonical home for the loader.
 *
 * Backward-compat shim: all existing imports of the loader helpers continue
 * to work unchanged (including tests that use _resetForTest / _injectLanguagesForTest).
 */
export {
  getParser,
  _resetForTest,
  _injectLanguagesForTest,
} from "@oxagen/code-graph/loader";
