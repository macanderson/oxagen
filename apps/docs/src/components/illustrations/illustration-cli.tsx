import { illustrationClassName } from "./hex-utils";

/**
 * CLI hero: a spare terminal frame — hairline window, three dotted lights,
 * a typed line rendered as neutral text, and a single thin ember caret.
 * The gradient touches nothing else.
 */

export function IllustrationCli({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>
        A terminal window with a single ember cursor after a typed prompt
      </title>
      <defs>
        <linearGradient id="ill-cli-g1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #F9D423)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #C2185B)" />
        </linearGradient>
        <radialGradient id="ill-cli-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-flame, #FF7E5F)"
            stopOpacity={0.75}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-flame, #FF7E5F)"
            stopOpacity={0}
          />
        </radialGradient>
      </defs>

      <rect
        x={60}
        y={40}
        width={440}
        height={120}
        rx={10}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.28}
      />
      <path
        d="M60,66 L500,66"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.16}
      />
      <circle cx={80} cy={53} r={2.5} fill="currentColor" opacity={0.25} />
      <circle cx={94} cy={53} r={2.5} fill="currentColor" opacity={0.25} />
      <circle cx={108} cy={53} r={2.5} fill="currentColor" opacity={0.25} />

      <text
        x={82}
        y={100}
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={14}
        fill="currentColor"
        opacity={0.5}
      >
        $ oxagen ask &quot;refactor the billing meter&quot;
      </text>
      <circle cx={444} cy={95} r={10} fill="url(#ill-cli-glow)" />
      <line
        x1={444}
        y1={88}
        x2={444}
        y2={102}
        stroke="url(#ill-cli-g1)"
        strokeWidth={1.5}
        strokeLinecap="round"
      />

      <text
        x={82}
        y={124}
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={11}
        fill="currentColor"
        opacity={0.28}
      >
        › reading packages/billing/src/meter.ts
      </text>
      <text
        x={82}
        y={142}
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={11}
        fill="currentColor"
        opacity={0.28}
      >
        › proposing 1 edit — awaiting approval
      </text>
    </svg>
  );
}
