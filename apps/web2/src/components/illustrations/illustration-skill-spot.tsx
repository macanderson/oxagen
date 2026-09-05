import { illustrationClassName } from "./hex-utils";

/**
 * Small spot for skill.author: a hairline nib tracing a partial hex into
 * being, with a single ember spark at the point of synthesis.
 */

export function IllustrationSkillSpot({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 120"
      className={illustrationClassName(className)}
    >
      <title>
        A pen nib synthesising a skill definition, marked by a single spark
      </title>
      <defs>
        <linearGradient id="ill-skill-spot-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--_ember-a, #725A00)" />
          <stop offset="1" stopColor="var(--_ember-c, #F7D96B)" />
        </linearGradient>
        <radialGradient id="ill-skill-spot-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-b, #EFC53F)"
            stopOpacity={0.8}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-b, #EFC53F)"
            stopOpacity={0}
          />
        </radialGradient>
      </defs>

      <path
        d="M200,80 L216,48 L224,48 L212,80 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
        opacity={0.3}
      />

      <path
        d="M228,48 C280,40 330,44 372,58"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="0.5 6"
        strokeLinecap="round"
        opacity={0.26}
      />

      <circle cx={372} cy={58} r={12} fill="url(#ill-skill-spot-glow)" />
      <path
        d="M362,50 L382,66 M382,50 L362,66"
        stroke="url(#ill-skill-spot-g1)"
        strokeWidth={1.25}
        strokeLinecap="round"
        opacity={0.4}
      />
      <circle cx={372} cy={58} r={2.5} fill="url(#ill-skill-spot-g1)" />
    </svg>
  );
}
