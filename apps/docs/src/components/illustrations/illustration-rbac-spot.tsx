import { illustrationClassName } from "./hex-utils";

/**
 * Small spot for the RBAC page: three hairline bars narrowing top to
 * bottom, echoing the role hierarchy. Only the widest bar — full access —
 * carries the single ember thread.
 */

const TOP_TIER = { y: 40, w: 200 };
const TIERS = [TOP_TIER, { y: 62, w: 140 }, { y: 84, w: 90 }];

export function IllustrationRbacSpot({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 120"
      className={illustrationClassName(className)}
    >
      <title>
        Three narrowing bars representing a role hierarchy from full to
        read-only access
      </title>
      <defs>
        <linearGradient id="ill-rbac-spot-g1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--_ember-a, #A37200)" />
          <stop offset="1" stopColor="var(--_ember-c, #FFCB66)" />
        </linearGradient>
      </defs>

      {TIERS.map((t, i) => (
        <line
          key={i}
          x1={280 - t.w / 2}
          y1={t.y}
          x2={280 + t.w / 2}
          y2={t.y}
          stroke={i === 0 ? "url(#ill-rbac-spot-g1)" : "currentColor"}
          strokeWidth={i === 0 ? 1.5 : 1}
          strokeLinecap="round"
          opacity={i === 0 ? 0.8 : 0.28}
        />
      ))}
      <circle
        cx={280 - TOP_TIER.w / 2}
        cy={TOP_TIER.y}
        r={2.5}
        fill="url(#ill-rbac-spot-g1)"
      />
    </svg>
  );
}
