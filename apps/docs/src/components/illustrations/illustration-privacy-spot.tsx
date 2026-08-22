import { illustrationClassName } from "./hex-utils";

/**
 * Small spot for privacy/GDPR pages: a hairline document with a folded
 * corner, and a thin arrow carrying it outward — the single ember thread
 * marks the export leaving the boundary.
 */

export function IllustrationPrivacySpot({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 120"
      className={illustrationClassName(className)}
    >
      <title>
        A document exporting outward, representing data portability and erasure
      </title>
      <defs>
        <linearGradient id="ill-privacy-spot-g1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--_ember-a, #A37200)" />
          <stop offset="1" stopColor="var(--_ember-c, #FFCB66)" />
        </linearGradient>
        <radialGradient id="ill-privacy-spot-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-b, #FFB000)"
            stopOpacity={0.75}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-b, #FFB000)"
            stopOpacity={0}
          />
        </radialGradient>
      </defs>

      <path
        d="M200,32 L240,32 L256,48 L256,88 L200,88 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
        opacity={0.32}
      />
      <path
        d="M240,32 L240,48 L256,48"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.32}
      />
      <line
        x1={210}
        y1={62}
        x2={246}
        y2={62}
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.22}
      />
      <line
        x1={210}
        y1={74}
        x2={236}
        y2={74}
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.22}
      />

      <path
        d="M280,60 L380,60"
        fill="none"
        stroke="url(#ill-privacy-spot-g1)"
        strokeWidth={1.25}
        strokeDasharray="0.5 5"
        strokeLinecap="round"
        opacity={0.7}
      />
      <path
        d="M372,52 L382,60 L372,68"
        fill="none"
        stroke="url(#ill-privacy-spot-g1)"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
      />
      <circle cx={382} cy={60} r={10} fill="url(#ill-privacy-spot-glow)" />
    </svg>
  );
}
