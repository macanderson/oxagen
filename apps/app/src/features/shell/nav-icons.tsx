// Lucide icons for the nav keys. Identity is an icon, never an emoji.
import {
  Building2,
  Coins,
  Compass,
  Fingerprint,
  KeyRound,
  type LucideIcon,
  Network,
  Radar,
  Receipt,
  ScrollText,
  Wrench,
} from "lucide-react";
import type { NavKey } from "./nav";

export const NAV_ICONS: Record<NavKey, LucideIcon> = {
  fleet: Radar,
  agents: Fingerprint,
  tools: Wrench,
  ontology: Network,
  steering: Compass,
  spend: Coins,
  organization: Building2,
  billing: Receipt,
  audit: ScrollText,
  apiKeys: KeyRound,
};
