// Lucide icons for the nav keys. Identity is an icon, never an emoji.
import {
  Building2,
  Coins,
  Compass,
  Fingerprint,
  KeyRound,
  type LucideIcon,
  Radar,
  Receipt,
  Wrench,
} from "lucide-react";
import type { NavKey } from "./nav";

export const NAV_ICONS: Record<NavKey, LucideIcon> = {
  fleet: Radar,
  agents: Fingerprint,
  tools: Wrench,
  steering: Compass,
  spend: Coins,
  organization: Building2,
  billing: Receipt,
  apiKeys: KeyRound,
};
