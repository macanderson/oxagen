// Phosphor icons for the nav keys. Identity is an icon, never an emoji.
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  BuildingsIcon,
  CoinsIcon,
  CompassIcon,
  CrosshairIcon,
  FingerprintIcon,
  FolderSimpleIcon,
  HardDrivesIcon,
  KeyIcon,
  LockKeyIcon,
  ReceiptIcon,
  ShieldCheckIcon,
  WalletIcon,
  WrenchIcon,
} from "@phosphor-icons/react/ssr";
import type { NavKey } from "./nav";

export const NAV_ICONS: Record<NavKey, PhosphorIcon> = {
  fleet: CrosshairIcon,
  agents: FingerprintIcon,
  tools: WrenchIcon,
  steering: CompassIcon,
  runtimes: HardDrivesIcon,
  repositories: FolderSimpleIcon,
  spend: CoinsIcon,
  organization: BuildingsIcon,
  billing: ReceiptIcon,
  audit: ShieldCheckIcon,
  apiKeys: KeyIcon,
  modelFunding: WalletIcon,
  sso: LockKeyIcon,
  roles: ShieldCheckIcon,
};
