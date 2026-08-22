import { illustrationClassName } from "./hex-utils";

/**
 * Small spot for BYOK / model governance: a hairline key reaching a gateway
 * hex outline over a dashed line — the single ember thread lives only in
 * the key's bow.
 */

export function IllustrationByokSpot({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 120"
      className={illustrationClassName(className)}
    >
      <title>
        A key reaching toward a gateway node, representing bring-your-own-key
        model access
      </title>
      <defs>
        <linearGradient id="ill-byok-spot-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--_ember-a, #A37200)" />
          <stop offset="1" stopColor="var(--_ember-c, #FFCB66)" />
        </linearGradient>
      </defs>

      <circle
        cx={150}
        cy={60}
        r={14}
        fill="none"
        stroke="url(#ill-byok-spot-g1)"
        strokeWidth={1.25}
        opacity={0.75}
      />
      <line
        x1={164}
        y1={60}
        x2={230}
        y2={60}
        stroke="currentColor"
        strokeWidth={1.25}
        opacity={0.32}
      />
      <line
        x1={210}
        y1={60}
        x2={210}
        y2={68}
        stroke="currentColor"
        strokeWidth={1.25}
        opacity={0.32}
      />
      <line
        x1={222}
        y1={60}
        x2={222}
        y2={72}
        stroke="currentColor"
        strokeWidth={1.25}
        opacity={0.32}
      />

      <path
        d="M240,60 L400,60"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="0.5 6"
        opacity={0.24}
      />

      <path
        d="M424,44 L440,52 L440,68 L424,76 L408,68 L408,52 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.32}
      />
    </svg>
  );
}
