// The assistant flyout's width, which the person sets by dragging its right
// edge. A cookie remembers it, so the flyout reopens at the width it was left
// at, on the next page and the next visit. It never goes below the width the
// flyout was designed at, 430px. The viewport sets the ceiling: the flyout
// keeps a 56px strip of the page in view (`assistant-flyout.tsx`), and CSS
// holds that cap as well, so a remembered width wider than a smaller screen
// shows at the screen's limit rather than off its edge.

/** The flyout's designed width, and the narrowest it can be dragged to. */
export const ASSISTANT_MIN_WIDTH = 430;

/** The strip of page the flyout always leaves in view to its right. */
const ASSISTANT_PAGE_GUTTER = 56;

/**
 * How far one arrow key press moves the edge.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export const ASSISTANT_WIDTH_STEP = 16;

const ASSISTANT_WIDTH_COOKIE = "assistant_width";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * The width the cookie holds, or the designed width when it holds nothing
 * usable. A value below the minimum, or one that is not a whole number of
 * pixels, reads as the minimum.
 */
export function readAssistantWidth(cookie: string): number {
  const match = /(?:^|;\s*)assistant_width=(\d{1,5})(?:;|$)/.exec(cookie);
  if (match?.[1] === undefined) return ASSISTANT_MIN_WIDTH;
  return Math.max(ASSISTANT_MIN_WIDTH, Number(match[1]));
}

/** The `document.cookie` assignment that remembers `width` for a year. */
export function assistantWidthCookieString(
  width: number,
  secure: boolean,
): string {
  return `${ASSISTANT_WIDTH_COOKIE}=${String(Math.round(width))}; Path=/; Max-Age=${String(ONE_YEAR_SECONDS)}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * The widest the flyout can be when its left edge sits at `left` in a
 * viewport `viewport` pixels wide. Never below the minimum, so a narrow
 * window still has a valid range.
 */
export function widestAssistant(left: number, viewport: number): number {
  return Math.max(
    ASSISTANT_MIN_WIDTH,
    Math.floor(viewport - left - ASSISTANT_PAGE_GUTTER),
  );
}

/** `width` held between the minimum and `widest`, in whole pixels. */
export function clampAssistantWidth(width: number, widest: number): number {
  return Math.round(
    Math.min(
      Math.max(width, ASSISTANT_MIN_WIDTH),
      Math.max(widest, ASSISTANT_MIN_WIDTH),
    ),
  );
}

/**
 * The width a key press on the handle moves to, or null for a key the handle
 * does not use. The arrows step, Home goes to the minimum, End to `widest`.
 */
export function widthForKey(
  key: string,
  width: number,
  widest: number,
): number | null {
  switch (key) {
    case "ArrowRight":
      return clampAssistantWidth(width + ASSISTANT_WIDTH_STEP, widest);
    case "ArrowLeft":
      return clampAssistantWidth(width - ASSISTANT_WIDTH_STEP, widest);
    case "Home":
      return ASSISTANT_MIN_WIDTH;
    case "End":
      return clampAssistantWidth(widest, widest);
    default:
      return null;
  }
}
