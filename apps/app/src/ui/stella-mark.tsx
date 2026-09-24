// The stella marks and spinner, drawn inline so they follow the app's theme.
//
// The house kit (`oxagenai/oxagen-brand`) generates both marks and
// `tools/scripts/sync-brand-assets.mjs` vendors its adaptive files into
// `public/brand/stella-wordmark.svg` and `public/brand/stella-icon.svg`. Those
// files adapt with `prefers-color-scheme`, which follows the operating system.
// The app has its own light, dark and system switch (`features/shell/theme.ts`),
// and an `<img>` never sees it, so a person on "dark" with a light system would
// get dark letters on the dark panel. Inline, the letters take `currentColor`
// from whatever they sit on, and the switch reaches them.
//
// The path data is the kit's, byte for byte. `stella-mark.test.tsx` reads the
// vendored files and fails when a kit rebuild changes a path here, so the mark
// is never redrawn by hand.
import { type SVGProps, useId } from "react";

/**
 * The kit's gold. The asterisk is the mark, so it stays gold in both themes.
 *
 * @internal Exported for its unit test, which checks it against the kit's file; nothing outside this module imports it.
 */
export const STELLA_GOLD = "#D4AF37";

/**
 * `viewBox` of the kit's wordmark.
 *
 * @internal Exported for its unit test, which checks it against the kit's file; nothing outside this module imports it.
 */
export const STELLA_WORDMARK_VIEWBOX = "0 0 405.544 94.003";

/**
 * The word "stella", set in Space Grotesk 600 by the kit.
 *
 * @internal Exported for its unit test, which checks it against the kit's file; nothing outside this module imports it.
 */
export const STELLA_WORDMARK_LETTERS =
  "M30.6465 94.0032Q18.0831 94.0032 9.90884 88.4736Q1.73458 82.944 0 72.237L13.959 68.725Q14.9037 73.7477 17.2603 76.6228Q19.617 79.4978 23.096 80.7206Q26.575 81.9433 30.6465 81.9433Q36.808 81.9433 39.9299 79.6953Q43.0518 77.4473 43.0518 73.9584Q43.0518 70.4465 40.0846 68.6971Q37.1174 66.9477 31.025 65.8484L26.9239 65.121Q20.216 63.8505 14.6929 61.5695Q9.16992 59.2885 5.85051 55.2763Q2.5311 51.264 2.5311 44.9741Q2.5311 35.4849 9.53691 30.3651Q16.5427 25.2452 27.9903 25.2452Q38.9179 25.2452 46.0553 30.1281Q53.1928 35.0109 55.3388 43.1638L41.3403 47.3505Q40.2409 41.8868 36.7158 39.5959Q33.1907 37.3051 27.9903 37.3051Q22.8129 37.3051 19.9889 39.1467Q17.1649 40.9882 17.1649 44.3224Q17.1649 47.8508 20.0284 49.5261Q22.8919 51.2014 27.783 52.0605L31.8841 52.7879Q39.1186 54.0584 44.9823 56.2077Q50.846 58.357 54.2658 62.3149Q57.6856 66.2729 57.6856 72.9808Q57.6856 83.0427 50.3507 88.523Q43.0157 94.0032 30.6465 94.0032Z M96.3204 92.16Q90.0996 92.16 86.3374 88.3864Q82.5753 84.6127 82.5753 78.2438V39.6289H65.5126V27.0884H82.5753V6.16817H97.6436V27.0884H116.332V39.6289H97.6436V75.6699Q97.6436 79.6196 101.376 79.6196H114.43V92.16Z M159.134 94.0032Q149.368 94.0032 141.953 89.856Q134.537 85.7088 130.401 78.15Q126.266 70.5913 126.266 60.4142V58.8343Q126.266 48.6341 130.347 41.0869Q134.429 33.5396 141.767 29.3924Q149.105 25.2452 158.755 25.2452Q168.251 25.2452 175.326 29.4319Q182.401 33.6186 186.351 41.0968Q190.301 48.5749 190.301 58.5348V63.9426H141.551Q141.838 71.5787 146.957 76.1949Q152.077 80.8111 159.568 80.8111Q166.892 80.8111 170.471 77.5986Q174.051 74.3862 175.923 70.3082L188.355 76.7265Q186.489 80.3109 183 84.3494Q179.511 88.388 173.764 91.1956Q168.018 94.0032 159.134 94.0032ZM141.683 52.5345H174.992Q174.465 46.0438 170.07 42.2406Q165.674 38.4374 158.647 38.4374Q151.425 38.4374 147.061 42.2406Q142.697 46.0438 141.683 52.5345Z M205.918 92.16V0H220.987V92.16Z M240.281 92.16V0H255.349V92.16Z M294.803 94.0032Q287.872 94.0032 282.354 91.5906Q276.835 89.178 273.621 84.5387Q270.407 79.8994 270.407 73.254Q270.407 66.5856 273.621 62.101Q276.835 57.6164 282.505 55.347Q288.174 53.0775 295.409 53.0775H314.282V49.1377Q314.282 43.9768 311.109 40.7726Q307.936 37.5684 301.225 37.5684Q294.645 37.5684 291.283 40.6294Q287.921 43.6905 286.861 48.6045L272.925 43.9767Q274.505 38.8586 277.983 34.6423Q281.46 30.4259 287.284 27.8356Q293.108 25.2452 301.442 25.2452Q314.206 25.2452 321.561 31.6734Q328.916 38.1016 328.916 50.1844V75.7159Q328.916 79.6657 332.602 79.6657H338.03V92.16H327.431Q322.698 92.16 319.677 89.7787Q316.655 87.3973 316.655 83.4015V83.1316H314.361Q313.627 84.9419 311.634 87.5438Q309.641 90.1456 305.622 92.0744Q301.603 94.0032 294.803 94.0032ZM297.285 81.68Q304.816 81.68 309.549 77.4045Q314.282 73.1289 314.282 65.8484V64.4857H296.41Q291.41 64.4857 288.443 66.6334Q285.476 68.781 285.476 72.7965Q285.476 76.812 288.574 79.246Q291.673 81.68 297.285 81.68Z";

/**
 * The gold asterisk that follows the word: the font's own glyph, never redrawn.
 *
 * @internal Exported for its unit test, which checks it against the kit's file; nothing outside this module imports it.
 */
export const STELLA_WORDMARK_ACCENT =
  "M346.864 33.8886V24.791H357.364L366.751 26.3644L367.409 24.7219L359.648 19.2779L352.245 11.7669L358.631 5.38148L366.142 12.7839L371.586 20.5451L373.228 19.8868L371.655 10.4996V0H380.753V10.4996L379.179 19.8868L380.822 20.5451L386.266 12.7839L393.777 5.38148L400.162 11.7669L392.76 19.2779L384.998 24.7219L385.657 26.3644L395.044 24.791H405.544V33.8886H395.044L385.657 32.3153L384.998 33.9577L392.76 39.4017L400.162 46.9128L393.777 53.2982L386.266 45.8958L380.822 38.1346L379.179 38.7928L380.753 48.18V58.6796H371.655V48.18L373.228 38.7928L371.586 38.1346L366.142 45.8958L358.631 53.2982L352.245 46.9128L359.648 39.4017L367.409 33.9577L366.751 32.3153L357.364 33.8886Z";

/**
 * `viewBox` of the kit's square mark.
 *
 * @internal Exported for its unit test, which checks it against the kit's file; nothing outside this module imports it.
 */
export const STELLA_ICON_VIEWBOX = "0 0 96 96";

/**
 * The placement the kit gives the asterisk inside the square.
 *
 * @internal Exported for its unit test, which checks it against the kit's file; nothing outside this module imports it.
 */
export const STELLA_ICON_TRANSFORM = "translate(13.423,109.664) scale(0.98160)";

/**
 * The asterisk alone, used where a square is required.
 *
 * @internal Exported for its unit test, which checks it against the kit's file; nothing outside this module imports it.
 */
export const STELLA_ICON_MARK =
  "M5.88507 -58.2714V-67.369H16.3847L25.7719 -65.7956L26.4302 -67.4381L18.669 -72.8821L11.2665 -80.3931L17.6519 -86.7785L25.163 -79.3761L30.607 -71.6149L32.2494 -72.2732L30.6761 -81.6604V-92.16H39.7737V-81.6604L38.2004 -72.2732L39.8428 -71.6149L45.2868 -79.3761L52.7978 -86.7785L59.1832 -80.3931L51.7808 -72.8821L44.0196 -67.4381L44.6779 -65.7956L54.0651 -67.369H64.5647V-58.2714H54.0651L44.6779 -59.8447L44.0196 -58.2023L51.7808 -52.7583L59.1832 -45.2472L52.7978 -38.8618L45.2868 -46.2642L39.8428 -54.0254L38.2004 -53.3672L39.7737 -43.98V-33.4804H30.6761V-43.98L32.2494 -53.3672L30.607 -54.0254L25.163 -46.2642L17.6519 -38.8618L11.2665 -45.2472L18.669 -52.7583L26.4302 -58.2023L25.7719 -59.8447L16.3847 -58.2714Z";

type MarkProps = Omit<SVGProps<SVGSVGElement>, "viewBox" | "children"> & {
  /**
   * The accessible name. Omit it where the mark sits beside its own name, or
   * inside a control that has one, and the mark is hidden from assistive
   * technology.
   */
  title?: string;
};

function a11y(title: string | undefined) {
  return title === undefined
    ? { "aria-hidden": true as const }
    : { role: "img" as const, "aria-label": title };
}

/**
 * The stella wordmark: the word in the colour of the text around it, then the
 * gold asterisk. Size it by height; the width follows the kit's proportions.
 */
export function StellaWordmark({ title, ...props }: MarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={STELLA_WORDMARK_VIEWBOX}
      focusable="false"
      data-mark="stella-wordmark"
      {...a11y(title)}
      {...props}
    >
      <path d={STELLA_WORDMARK_LETTERS} fill="currentColor" />
      <path d={STELLA_WORDMARK_ACCENT} fill={STELLA_GOLD} />
    </svg>
  );
}

/**
 * The light that sweeps across the spinner's asterisk.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export const STELLA_SHIMMER = "#F1CE65";

/**
 * The placement `oxagen-brand/spinners/stella-spinner.svg` gives the asterisk,
 * a little larger than the icon's so the turning points stay inside the square.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export const STELLA_SPINNER_TRANSFORM =
  "translate(8.813,117.886) scale(1.11248)";

/**
 * The kit's stella spinner: the asterisk turns and a light sweeps across it.
 * Drawn inline for the reason the marks are, and because the sweep needs
 * gradient and clip ids that stay unique when two spinners share a page. The
 * motion is `.ox-stella-turn` and `.ox-stella-sweep` in `app/globals.css`, which
 * hold still under reduced motion.
 */
export function StellaSpinner({ title, ...props }: MarkProps) {
  const id = useId().replace(/[^\w-]/g, "");
  const clip = `stella-spin-clip-${id}`;
  const sweep = `stella-spin-sweep-${id}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={STELLA_ICON_VIEWBOX}
      focusable="false"
      data-mark="stella-spinner"
      {...a11y(title)}
      {...props}
    >
      <defs>
        <clipPath id={clip}>
          <path d={STELLA_ICON_MARK} />
        </clipPath>
        <linearGradient id={sweep} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={STELLA_SHIMMER} stopOpacity="0" />
          <stop offset="0.5" stopColor={STELLA_SHIMMER} stopOpacity="0.95" />
          <stop offset="1" stopColor={STELLA_SHIMMER} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g transform={STELLA_SPINNER_TRANSFORM}>
        <g className="ox-stella-turn">
          <path d={STELLA_ICON_MARK} fill={STELLA_GOLD} />
          <g clipPath={`url(#${clip})`}>
            <rect
              className="ox-stella-sweep"
              x="-49.86"
              y="-98.03"
              width="32.27"
              height="70.42"
              fill={`url(#${sweep})`}
              transform="skewX(-18)"
            />
          </g>
        </g>
      </g>
    </svg>
  );
}

/** The stella asterisk in its square, for places too small for the word. */
export function StellaIcon({ title, ...props }: MarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={STELLA_ICON_VIEWBOX}
      focusable="false"
      data-mark="stella-icon"
      {...a11y(title)}
      {...props}
    >
      <g transform={STELLA_ICON_TRANSFORM}>
        <path d={STELLA_ICON_MARK} fill={STELLA_GOLD} />
      </g>
    </svg>
  );
}
