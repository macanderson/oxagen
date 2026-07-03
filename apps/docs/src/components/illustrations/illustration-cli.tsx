import { illustrationClassName } from "./hex-utils";

/**
 * CLI hero: a terminal window with a typed `oxagen` prompt, an ember caret,
 * and two faint output lines — the "agent in your terminal" first
 * impression for the CLI section of the docs.
 */

export function IllustrationCli({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>Terminal window with a typed oxagen prompt and an ember cursor</title>
      <defs>
        <linearGradient id="ill-cli-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #fd9a4b)" />
          <stop offset="0.5" stopColor="var(--_ember-flame, #f07650)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #eb5c5e)" />
        </linearGradient>
      </defs>

      <rect
        x={40}
        y={28}
        width={480}
        height={144}
        rx={12}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        opacity={0.4}
      />
      <path
        d="M40,60 L520,60"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        opacity={0.25}
      />
      <circle cx={64} cy={44} r={4.5} fill="currentColor" opacity={0.3} />
      <circle cx={82} cy={44} r={4.5} fill="currentColor" opacity={0.3} />
      <circle cx={100} cy={44} r={4.5} fill="currentColor" opacity={0.3} />

      <text
        x={62}
        y={92}
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={17}
        fill="currentColor"
        opacity={0.85}
      >
        $ <tspan fill="url(#ill-cli-g1)">oxagen</tspan> ask &quot;refactor the billing meter&quot;
      </text>
      <rect x={62} y={100} width={9} height={18} rx={1.5} fill="url(#ill-cli-g1)" opacity={0.9} />

      <text
        x={62}
        y={128}
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={13}
        fill="currentColor"
        opacity={0.4}
      >
        › reading packages/billing/src/meter.ts
      </text>
      <text
        x={62}
        y={148}
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={13}
        fill="currentColor"
        opacity={0.4}
      >
        › proposing 1 edit — awaiting approval
      </text>
    </svg>
  );
}
