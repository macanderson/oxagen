# SUPERSEDED — Space Grotesk is no longer the wordmark face

This was the handoff note for adding **Space Grotesk** and pointing
`.ox-wordmark` at it, alongside the "Nocturne Violet" token set. Both have since
been replaced by the brand shipped on **oxagen.sh**, so the instructions it
carried no longer describe this tree — following them now would put the one
element that appears on every surface back into a typeface the website does not
load.

**What is true now:**

- The wordmark is set in **Aeonik**, weight 660 / tracking -0.02em — oxagen.sh's
  own `.brand` values. See `--font-wordmark` and `.ox-wordmark` in
  `packages/ui/src/styles/globals.css`, and `packages/ui/THEME.md`.
- `space-grotesk.css` is **no longer imported** by `globals.css`; the wordmark
  was its only consumer.
- `SpaceGrotesk-VF.woff2` and `space-grotesk.css` are still in this directory,
  unreferenced. They are kept rather than deleted so the choice stays
  reversible — deleting a licensed binary is a separate decision from changing
  which face the wordmark uses. If nothing adopts them, they can go.

The rest of the type system is unchanged: **Aeonik** for UI and body, **Aeonik
Fono** for display headings, **Aeonik Mono** for code and eyebrows. See
`aeonik.css` in this directory for the `@font-face` declarations and the
licensing note (Aeonik is commercial — self-hosted delivery from our own origin
only; do not redistribute those binaries).
