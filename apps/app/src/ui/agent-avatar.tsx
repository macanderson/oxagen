import { Avatar } from "./avatar";
import { HarnessIcon } from "./harness-icon";

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
  size?: number;
  surface?: "panel" | "background";
}) {
  const badgeSize = Math.max(10, Math.round(size * 0.46));
  return (
    <span
      aria-hidden="true"
      data-agent-avatar=""
      className="relative inline-block shrink-0 align-middle leading-none"
      style={{ width: size, height: size }}
    >
      <Avatar value={value} initials={initials} shape="agent" size={size} />
      {harness ? (
        <span
          data-harness-badge={harness}
          className={`absolute -bottom-[3px] -left-[3px] grid place-items-center rounded-full ring-[1.5px] ${surface === "background" ? "bg-background ring-background" : "bg-app-panel-bg ring-app-panel-bg"}`}
          style={{ width: badgeSize, height: badgeSize }}
        >
          <HarnessIcon harness={harness} size={badgeSize - 3} />
        </span>
      ) : null}
    </span>
  );
}
