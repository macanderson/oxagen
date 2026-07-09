/**
 * HexField lives in @oxagen/ui as the canonical, shared source so the docs
 * landing page and the app hero backdrop render the identical hex constellation.
 * This file is the docs app's local UI re-export layer (the one place allowed to
 * touch `@oxagen/ui/components/*`), giving callers the `@/components/ui/hex-field`
 * indirection. Lit cells animate via the shared `.ox-hex-lit` rule (in
 * @oxagen/ui/styles/globals.css, imported by this app); the field's float/opacity
 * are still controlled by the caller's classes.
 */
export { HexField } from "@oxagen/ui/components/hex-field";
