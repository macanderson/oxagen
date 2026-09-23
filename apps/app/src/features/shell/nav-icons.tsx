// Lucide icons for the nav keys. Identity is an icon, never an emoji.
import {
  Building2,
  Coins,
  Compass,
  Fingerprint,
  FolderGit2,
  KeyRound,
  LockKeyhole,
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
  steering: Compass,
  repositories: FolderGit2,
  spend: Coins,
  organization: Building2,
  billing: Receipt,
  audit: ShieldCheck,
  apiKeys: KeyRound,
  modelFunding: Wallet,
  sso: LockKeyhole,
  roles: ShieldCheck,
};
