import { hexPoints, illustrationClassName } from "./hex-utils";

/**
 * Getting-started hero: the onboarding journey rendered as a launch path —
 * terminal prompt (sign up) to organization hex (create org) to a workspace
 * hex cluster (land in the app shell) — matching the page's three-step flow.
 */

const WORKSPACE_HEXES = [
  { cx: 452, cy: 84, r: 15, lit: false },
  { cx: 484, cy: 84, r: 15, lit: true },
  { cx: 452, cy: 116, r: 15, lit: false },
  { cx: 484, cy: 116, r: 15, lit: false },
];

export function IllustrationGettingStarted({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>Launch path from sign-up terminal to organization to workspace</title>
      <defs>
        <linearGradient id="ill-getting-started-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #fd9a4b)" />
          <stop offset="0.5" stopColor="var(--_ember-flame, #f07650)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #eb5c5e)" />
        </linearGradient>
      </defs>

      {/* stage 1 — sign-up terminal */}
      <rect
        x={32}
        y={70}
        width={100}
        height={60}
        rx={8}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        opacity={0.45}
      />
      <path
        d="M48,92 L60,100 L48,108"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
      />
      <rect x={66} y={104} width={8} height={4} rx={1} fill="url(#ill-getting-started-g1)" />

      {/* arrow 1 */}
      <path
        d="M138,100 L214,100"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray="4 5"
        strokeLinecap="round"
        opacity={0.4}
      />
      <path
        d="M206,93 L216,100 L206,107"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.5}
      />
      <circle cx={176} cy={100} r={4} fill="url(#ill-getting-started-g1)" />

      {/* stage 2 — organization hex */}
      <polygon
        points={hexPoints(270, 100, 36)}
        fill="none"
        stroke="url(#ill-getting-started-g1)"
        strokeWidth={2}
      />
      <polygon points={hexPoints(270, 100, 15)} fill="url(#ill-getting-started-g1)" opacity={0.9} />

      {/* arrow 2 */}
      <path
        d="M322,100 L398,100"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray="4 5"
        strokeLinecap="round"
        opacity={0.4}
      />
      <path
        d="M390,93 L400,100 L390,107"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.5}
      />
      <circle cx={360} cy={100} r={4} fill="url(#ill-getting-started-g1)" />

      {/* stage 3 — workspace hex cluster */}
      {WORKSPACE_HEXES.map((h, i) => (
        <polygon
          key={i}
          points={hexPoints(h.cx, h.cy, h.r)}
          fill={h.lit ? "url(#ill-getting-started-g1)" : "none"}
          stroke={h.lit ? "none" : "currentColor"}
          strokeWidth={1.5}
          opacity={h.lit ? 0.92 : 0.4}
        />
      ))}

      <text
        x={82}
        y={150}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={11}
        fill="currentColor"
        opacity={0.5}
      >
        sign up
      </text>
      <text
        x={270}
        y={158}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={11}
        fill="currentColor"
        opacity={0.5}
      >
        organization
      </text>
      <text
        x={468}
        y={150}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={11}
        fill="currentColor"
        opacity={0.5}
      >
        workspace
      </text>
    </svg>
  );
}
