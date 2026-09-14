// The onboarding gate and Register an agent (spec §4.4, §7.2): the namespaces
// agent keys are minted in, the one-click installer offer, the first frame a
// freshly wrapped agent sends, and the repository the installer saw. The gate
// state itself is `org.onboarding_state` (plan §3.4 G15), not recorded yet.
import { z } from "zod";
import { EnforcementTier, Instant, Slug } from "./common";

/** A namespace segment of an agent key (`acme` in `acme.core.release-manager`). */
export const Namespace = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
export type Namespace = z.infer<typeof Namespace>;

/** The organization and workspace namespaces agent keys are minted in. */
export const FlowNamespaces = z.object({
  org: Namespace,
  ws: Namespace,
});
export type FlowNamespaces = z.infer<typeof FlowNamespaces>;

/** The organization and workspace a flow runs in, with the namespaces agent keys use. */
export const FlowScope = z.object({
  org: z.object({ slug: Slug, name: z.string().min(1), namespace: Namespace }),
  ws: z.object({ slug: Slug, name: z.string().min(1), namespace: Namespace }),
  operator: z.object({ name: z.string(), email: z.string() }),
});
export type FlowScope = z.infer<typeof FlowScope>;

/**
 * Where the organization stands in the onboarding gate: the gate unlocks when
 * the first frame from a wrapped agent arrives. Null until it has.
 */
export const OnboardingGate = z.object({
  firstFrameAt: Instant.nullable(),
});
export type OnboardingGate = z.infer<typeof OnboardingGate>;

export const InstallerPlatform = z.enum(["macos", "windows", "linux"]);
export type InstallerPlatform = z.infer<typeof InstallerPlatform>;

/** A signed installer build for one platform (spec §7.2). */
export const InstallerBuild = z.object({
  file: z.string().min(1),
  size: z.string().min(1),
  signature: z.string().min(1),
  digest: z.string().min(1),
});
export type InstallerBuild = z.infer<typeof InstallerBuild>;

/** The one-click installer offer: a single-use enrollment token embedded in per-platform builds. */
export const InstallerOffer = z.object({
  token: z.string().min(1),
  tokenExpiresInMinutes: z.number().int().positive(),
  host: z.string().min(1),
  builds: z.record(InstallerPlatform, InstallerBuild),
  /** The agent credential an SDK agent is issued, masked; shown once. */
  sdkCredentialMasked: z.string().min(1),
});
export type InstallerOffer = z.infer<typeof InstallerOffer>;

export const EnrollmentLogLine = z.object({
  at: z.string().min(1),
  text: z.string().min(1),
  firstFrame: z.boolean().optional(),
});
export type EnrollmentLogLine = z.infer<typeof EnrollmentLogLine>;

export const FirstFrame = z.object({
  seq: z.string().regex(/^\d+$/),
  at: z.string().min(1),
  kind: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/),
  body: z.string(),
});
export type FirstFrame = z.infer<typeof FirstFrame>;

/** How the installer's smoke session reaches Oxagen, line by line, and the frames that open the app. */
export const FirstFrameScript = z.object({
  host: z.string().min(1),
  log: z.array(EnrollmentLogLine).min(1),
  frames: z.array(FirstFrame).min(1),
  tier: EnforcementTier,
  /** Milliseconds between log lines while waiting. */
  paceMs: z.number().int().positive(),
});
export type FirstFrameScript = z.infer<typeof FirstFrameScript>;

/** The repository the installer read from its working directory's git remote (spec §4.4). */
export const DetectedRepository = z.object({
  fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  remote: z.string().min(1),
  directory: z.string().min(1),
  branch: z.string().min(1),
  provisionalDays: z.number().int().positive(),
});
export type DetectedRepository = z.infer<typeof DetectedRepository>;
