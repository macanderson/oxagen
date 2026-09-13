// What the onboarding screens read, as view models. Promote: an OnboardingReadPort
// in src/data/ports.ts (lane L1) with these shapes; they live here until then.
import type { EnforcementTier } from "@/data/contracts/common";
import type { Platform } from "./steps";

/** The organization and workspace a flow runs in, with the namespaces agent keys use. */
export type FlowScope = {
  org: { slug: string; name: string; namespace: string };
  ws: { slug: string; name: string; namespace: string };
  operator: { name: string; email: string };
};

/** A signed installer build for one platform (spec §7.2). */
export type InstallerBuild = {
  file: string;
  size: string;
  signature: string;
  digest: string;
};

/** The one-click installer offer: a single-use enrollment token embedded in per-platform builds. */
export type InstallerOffer = {
  token: string;
  tokenExpiresInMinutes: number;
  host: string;
  builds: Record<Platform, InstallerBuild>;
  /** The agent credential an SDK agent is issued, masked; shown once. */
  sdkCredentialMasked: string;
};

export type EnrollmentLogLine = {
  at: string;
  text: string;
  firstFrame?: boolean;
};

export type FirstFrame = {
  seq: string;
  at: string;
  kind: string;
  body: string;
};

/** How the installer's smoke session reaches Oxagen, line by line, and the frames that open the app. */
export type FirstFrameScript = {
  host: string;
  log: EnrollmentLogLine[];
  frames: FirstFrame[];
  tier: EnforcementTier;
  /** Milliseconds between log lines while waiting. */
  paceMs: number;
};

/** The repository the installer read from its working directory's git remote (spec §4.4). */
export type DetectedRepository = {
  fullName: string;
  remote: string;
  directory: string;
  branch: string;
  provisionalDays: number;
};
