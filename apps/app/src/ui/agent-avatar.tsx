import { Avatar } from "./avatar";
import { AVATAR_SCALE, avatarSide } from "./avatar-size";
import { HarnessIcon } from "./harness-icon";

/**
 * How much larger the harness badge draws than it did before `AVATAR_SCALE`.
 * It grows a step more than the avatar does, so the harness logo gains on the
 * tile it sits on and stays readable at list sizes.
 */
const BADGE_SCALE = AVATAR_SCALE + 0.05;

/** The badge's side for an avatar of the named size: under half the tile, never under 12px. */
function badgeSide(size: number): number {
  return Math.round(Math.max(10, size * 0.46) * BADGE_SCALE);
}

/** An agent avatar with its recorded harness in the lower-left corner. */
export function AgentAvatar({
  value,
  initials,
  harness,
  size = 28,
  surface = "panel",
}: {
  value: string | null | undefined;
  initials: string;
  /** The recorded identifier, never a translated display name. */
  harness: string | null | undefined;
  /** The avatar's size before `AVATAR_SCALE`, as `Avatar` takes it. */
  size?: number;
  surface?: "panel" | "background";
}) {
  const side = avatarSide(size);
  const badgeSize = badgeSide(size);
  return (
    <span
      aria-hidden="true"
      data-agent-avatar=""
      className="relative inline-block shrink-0 align-middle leading-none"
      style={{ width: side, height: side }}
    >
      <Avatar value={value} initials={initials} shape="agent" size={size} />
      {harness ? (
        <span
          data-harness-badge={harness}
          className={`absolute -bottom-0.75 -left-0.75 grid place-items-center rounded-full ring-[1.5px] ${surface === "background" ? "bg-background ring-background" : "bg-app-panel-bg ring-app-panel-bg"}`}
          style={{ width: badgeSize, height: badgeSize }}
        >
          <HarnessIcon harness={harness} size={badgeSize - 3} />
        </span>
      ) : null}
    </span>
  );
}
