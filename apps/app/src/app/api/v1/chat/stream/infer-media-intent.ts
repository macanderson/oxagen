/**
 * infer-media-intent.ts — decide, from a user's chat prompt alone, whether this
 * turn is asking the system to GENERATE an image or a video.
 *
 * This replaces the old manual "Generate image / Generate video" composer +
 * settings toggles: the user no longer flips a mode, they just describe what
 * they want ("make me a logo", "create a short video of waves") and the stream
 * route routes the turn to `streamMediaGeneration` when the intent is clear.
 *
 * Design priorities, in order:
 *   1. PRECISION over recall. A false positive suppresses the text answer for
 *      the whole turn (the media branch does not run the text agent), which is
 *      the worse failure — so the vocabulary is curated toward visual-creative
 *      words and every match must survive a proximity + negative-tail check.
 *   2. Zero latency / zero cost. It runs on every app chat turn, so it is a
 *      pure synchronous token scan — never an LLM call.
 *   3. Deterministic + fully unit-tested (see infer-media-intent.test.ts).
 *
 * A miss in either direction is recoverable (the user rephrases), so we err
 * toward NOT hijacking an ordinary chat turn.
 */

export type MediaIntent = "image" | "video";

/**
 * Verbs that express intent to PRODUCE a new artifact. Deliberately excludes
 * highly polysemous dev verbs (compose/craft/imagine/visualize/depict) whose
 * media sense is rare; the ones kept are disambiguated by the strong-noun
 * requirement below (e.g. "design a schema" has no media noun, so it never
 * fires; "design a logo" does).
 */
const GENERATION_VERB_BASES = [
  "generate",
  "create",
  "make",
  "draw",
  "paint",
  "illustrate",
  "sketch",
  "animate",
  "design",
  "render",
  "produce",
];

/**
 * Strong image nouns — words that in a "produce X" construction almost always
 * mean a raster picture. Intentionally OMITS dev-overloaded terms (icon,
 * avatar, banner, thumbnail, graphic, mockup, diagram) that appear constantly
 * in engineering chat and would cause false positives.
 */
const IMAGE_NOUNS = new Set([
  "image",
  "images",
  "picture",
  "pictures",
  "photo",
  "photos",
  "photograph",
  "photographs",
  "illustration",
  "illustrations",
  "drawing",
  "drawings",
  "artwork",
  "painting",
  "paintings",
  "portrait",
  "portraits",
  "logo",
  "logos",
  "poster",
  "posters",
  "wallpaper",
  "wallpapers",
  "headshot",
  "headshots",
  "selfie",
  "caricature",
]);

/** Strong video nouns. */
const VIDEO_NOUNS = new Set([
  "video",
  "videos",
  "clip",
  "clips",
  "animation",
  "animations",
  "movie",
  "movies",
  "film",
  "films",
  "gif",
  "gifs",
  "reel",
  "reels",
  "trailer",
  "trailers",
  "montage",
]);

/**
 * Words that, immediately after an apparent media noun, flip it into a
 * non-media technical phrase — "image classifier", "video codec", "photo
 * upload", "image url". When a noun is followed by one of these it does NOT
 * count as a generation target.
 */
const NEGATIVE_TAILS = new Set([
  "codec",
  "codecs",
  "player",
  "players",
  "call",
  "calls",
  "conference",
  "conferencing",
  "game",
  "games",
  "chat",
  "stream",
  "streaming",
  "editor",
  "editing",
  "tutorial",
  "tutorials",
  "course",
  "courses",
  "api",
  "apis",
  "sdk",
  "sdks",
  "pipeline",
  "pipelines",
  "format",
  "formats",
  "file",
  "files",
  "upload",
  "uploads",
  "classifier",
  "classification",
  "recognition",
  "detection",
  "library",
  "libraries",
  "gallery",
  "component",
  "components",
  "feature",
  "features",
  "model",
  "models",
  "dataset",
  "datasets",
  "tag",
  "tags",
  "field",
  "fields",
  "column",
  "columns",
  "url",
  "urls",
  "link",
  "links",
  "picker",
  "uploader",
  "carousel",
]);

/** How many words after a generation verb we still count a media noun as its
 *  target. Small enough to stay within one clause ("make me a short video"). */
const NOUN_WINDOW = 6;

/** Build the inflected surface forms of a base verb (base, +s, +ed/+d, +ing),
 *  handling the silent-e drop, plus a couple of irregulars. */
function inflect(base: string): string[] {
  const forms = [base, `${base}s`];
  if (base.endsWith("e")) {
    forms.push(`${base}d`, `${base.slice(0, -1)}ing`);
  } else {
    forms.push(`${base}ed`, `${base}ing`);
  }
  return forms;
}

const GENERATION_VERBS = new Set<string>([
  ...GENERATION_VERB_BASES.flatMap(inflect),
  "made", // make
  "drew", // draw
  "drawn",
]);

/** Lowercase word tokens (letters only) — punctuation and digits are dropped. */
function tokenize(prompt: string): string[] {
  return prompt.toLowerCase().match(/[a-z]+/g) ?? [];
}

/**
 * Infer whether the prompt is a request to generate an image or a video.
 *
 * Returns `null` (run the normal text turn) unless a curated generation verb is
 * followed, within {@link NOUN_WINDOW} words, by a strong media noun that is NOT
 * immediately followed by a disqualifying technical tail. Video intent wins over
 * image intent when both are present in the same prompt.
 *
 * Guards: never fires when the user attached media (they're asking ABOUT it, not
 * generating new media) or when the turn is a code-mode/coding-agent turn.
 */
export function inferMediaIntent(
  prompt: string,
  opts: { hasAttachments?: boolean; isCodeMode?: boolean } = {},
): MediaIntent | null {
  if (opts.hasAttachments || opts.isCodeMode) return null;

  const words = tokenize(prompt);
  if (words.length === 0) return null;

  let imageHit = false;
  let videoHit = false;

  for (let i = 0; i < words.length; i++) {
    if (!GENERATION_VERBS.has(words[i]!)) continue;
    const end = Math.min(words.length, i + 1 + NOUN_WINDOW);
    for (let j = i + 1; j < end; j++) {
      const noun = words[j]!;
      const tail = words[j + 1];
      const disqualified = tail !== undefined && NEGATIVE_TAILS.has(tail);
      if (disqualified) continue;
      if (VIDEO_NOUNS.has(noun)) videoHit = true;
      else if (IMAGE_NOUNS.has(noun)) imageHit = true;
    }
  }

  if (videoHit) return "video";
  if (imageHit) return "image";
  return null;
}
