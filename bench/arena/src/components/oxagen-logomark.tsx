/**
 * Oxagen Logomark
 *
 * Self-contained copy of the ember hex-cluster mark from
 * `packages/ui/src/components/brand.tsx` — bench/arena deliberately takes no
 * workspace dependencies, so the mark is inlined here rather than imported.
 *
 * Four outline cells inherit the current text colour so they flip with the
 * theme; the two lit cells use the canonical ember gradient (gold → flame →
 * crimson). The gradient is canonical brand — never recolour it to the local
 * arena palette.
 */

const EMBER_ID = "arenaEmber";
const EMBER_ID_2 = "arenaEmber2";

export function OxagenLogomark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="7.775 4.325 36.343 37.216"
      fill="none"
      role="img"
      aria-label="Oxagen logomark"
      className={className}
    >
      <defs>
        <linearGradient
          id={EMBER_ID}
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(27.9194 19.5129 -21.9367 24.8347 12.2858 18.2731)"
          x1="0"
          y1="0"
          x2="1"
          y2="0"
        >
          <stop offset="0" stopColor="#FD9A4B" />
          <stop offset=".5" stopColor="#F07650" />
          <stop offset="1" stopColor="#EB5C5E" />
        </linearGradient>
        <linearGradient
          id={EMBER_ID_2}
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(12.59 0 0 12.59 9.77471 32.9406)"
          x1="0"
          y1="0"
          x2="1"
          y2="0"
        >
          <stop offset="0" stopColor="#FD9A4B" />
          <stop offset=".5" stopColor="#F07650" />
          <stop offset="1" stopColor="#EB5C5E" />
        </linearGradient>
      </defs>
      {/* Outline cells — ink that flips with the theme (inherits text colour) */}
      <g fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="miter">
        <path d="M16.1893 6.32478L21.9857 9.3639L21.9857 15.4418L16.1893 18.4806L10.3929 15.4418L10.3929 9.3639L16.1893 6.32478Z" />
        <path d="M29.2662 6.32478L35.0626 9.3639L35.0626 15.4418L29.2662 18.4806L23.4698 15.4418L23.4698 9.3639L29.2662 6.32478Z" />
        <path d="M22.6376 16.5647L28.4341 19.6038L28.4341 25.6814L22.6376 28.7205L16.8412 25.6814L16.8412 19.6038L22.6376 16.5647Z" />
        <path d="M29.2662 26.8043L35.0626 29.8431L35.0626 35.921L29.2662 38.9601L23.4698 35.921L23.4698 29.8431L29.2662 26.8043Z" />
      </g>
      {/* Ember cells — the canonical gradient accent */}
      <path
        d="M35.8698 16.2903L42.1182 19.4993L42.1182 25.9165L35.8698 29.1255L29.6214 25.9165L29.6214 19.4993L35.8698 16.2903Z"
        fill={`url(#${EMBER_ID})`}
      />
      <path
        d="M16.0697 26.3399L22.3647 29.6401L22.3647 36.2408L16.0697 39.5413L9.77471 36.2408L9.77471 29.6401L16.0697 26.3399Z"
        fill={`url(#${EMBER_ID_2})`}
        opacity=".55"
      />
    </svg>
  );
}
