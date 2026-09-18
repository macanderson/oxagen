// Lucide icons for the nav keys. Identity is an icon, never an emoji.
import {
  Building2,
  Coins,
  Compass,
  Fingerprint,
  GraduationCap,
  KeyRound,
  type LucideIcon,
  Radar,
  Receipt,
  ShieldCheck,
  Wallet,
  Wrench,
} from "lucide-react";
import type { NavKey } from "./nav";

export const NAV_ICONS: Record<NavKey, LucideIcon> = {
  fleet: Radar,
  agents: Fingerprint,
  tools: Wrench,
  skills: GraduationCap,
  steering: Compass,
  spend: Coins,
  organization: Building2,
  billing: Receipt,
  audit: ShieldCheck,
  apiKeys: KeyRound,
  modelFunding: Wallet,
  roles: ShieldCheck,
};
