// Phosphor icons for the nav keys. Identity is an icon, never an emoji.
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  BuildingsIcon,
  CoinsIcon,
  CompassIcon,
  CrosshairIcon,
  FolderSimpleIcon,
  KeyIcon,
  ListChecksIcon,
  LockKeyIcon,
  ReceiptIcon,
  RobotIcon,
  ShieldCheckIcon,
  WalletIcon,
} from "@phosphor-icons/react/ssr";
import type { NavKey } from "./nav";

export const NAV_ICONS: Record<NavKey, PhosphorIcon> = {
  work: ListChecksIcon,
  fleet: CrosshairIcon,
  agents: RobotIcon,
  steering: CompassIcon,
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
