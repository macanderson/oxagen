import { createHash } from "node:crypto";

export const CONTAINED_PROFILE = "oxagen-linux-docker-v1";
export const CONTAINED_HARNESSES = ["claude-code", "codex"] as const;
export type ContainedHarness = (typeof CONTAINED_HARNESSES)[number];

export interface ContainedLaunchSpec {
  name: string;
  image: string;
  workspace: string;
  sessionDirectory: string;
  uid: number;
  gid: number;
  harness: ContainedHarness;
  args: string[];
}

/** Docker mount syntax has its own parser; reject its delimiters before use. */
function mountPath(path: string): string {
  if (!path.startsWith("/") || /[,\r\n\0]/.test(path)) {
    throw new Error(
      "Contained mounts need absolute paths without commas or control bytes",
    );
  }
  return path;
}

export function containerArguments(spec: ContainedLaunchSpec): string[] {
  if (!/^oxagen-contained-[a-f0-9]{32}$/.test(spec.name))
    throw new Error("Invalid contained container name");
  if (!/^sha256:[a-f0-9]{64}$/.test(spec.image))
    throw new Error("Contained execution requires a resolved image digest");
  if (
    !Number.isSafeInteger(spec.uid) ||
    spec.uid <= 0 ||
    !Number.isSafeInteger(spec.gid) ||
    spec.gid < 0
  )
    throw new Error("Contained execution requires an unprivileged Linux user");
  if (!CONTAINED_HARNESSES.includes(spec.harness))
    throw new Error("Unsupported contained harness");
  return [
    "create",
    "--name",
    spec.name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--pids-limit",
    "512",
    "--memory",
    "4g",
    "--cpus",
    "2",
    "--init",
    "--user",
    `${spec.uid}:${spec.gid}`,
    "--mount",
    `type=bind,src=${mountPath(spec.workspace)},dst=/workspace`,
    "--mount",
    `type=bind,src=${mountPath(spec.sessionDirectory)},dst=/opt/oxagen/session,readonly`,
    "--workdir",
    "/workspace",
    "--env",
    "HOME=/workspace/.oxagen-contained/home",
    "--env",
    "TMPDIR=/workspace/.oxagen-contained/tmp",
    "--entrypoint",
    "/usr/local/bin/node",
    spec.image,
    "/opt/oxagen/entry.mjs",
    spec.harness,
    ...spec.args,
  ];
}

interface DockerInspect {
  Id?: string;
  Image?: string;
  Config?: {
    User?: string;
    Entrypoint?: string[];
    Cmd?: string[];
    WorkingDir?: string;
  };
  HostConfig?: {
    NetworkMode?: string;
    ReadonlyRootfs?: boolean;
    Privileged?: boolean;
    CapAdd?: string[] | null;
    CapDrop?: string[];
    SecurityOpt?: string[];
    PidMode?: string;
    IpcMode?: string;
    UsernsMode?: string;
    CgroupnsMode?: string;
    Devices?: unknown[];
    DeviceRequests?: unknown[] | null;
  };
  Mounts?: Array<{
    Type?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
  }>;
}

export interface ContainmentMeasurement {
  profile: typeof CONTAINED_PROFILE;
  containerId: string;
  imageDigest: string;
  configurationDigest: string;
  gatewayOnlyEgress: true;
  workspaceOnlyWrites: true;
  readOnlyHooks: true;
}

/** Measure Docker's created container before starting any agent process. */
export function measureContainer(
  raw: unknown,
  spec: ContainedLaunchSpec,
  configuration: string,
): ContainmentMeasurement {
  const value = raw as DockerInspect;
  const host = value?.HostConfig;
  const config = value?.Config;
  const mounts = value?.Mounts;
  const expectedCommand = ["/opt/oxagen/entry.mjs", spec.harness, ...spec.args];
  const safe =
    /^([a-f0-9]{64})$/.test(value?.Id ?? "") &&
    value?.Image === spec.image &&
    host?.NetworkMode === "none" &&
    host.ReadonlyRootfs === true &&
    host.Privileged === false &&
    (host.CapAdd?.length ?? 0) === 0 &&
    host.CapDrop?.includes("ALL") === true &&
    host.SecurityOpt?.some(
      (option) =>
        option === "no-new-privileges" || option === "no-new-privileges=true",
    ) === true &&
    host.PidMode === "" &&
    host.IpcMode === "private" &&
    host.UsernsMode === "" &&
    host.CgroupnsMode === "private" &&
    (host.Devices?.length ?? 0) === 0 &&
    (host.DeviceRequests?.length ?? 0) === 0 &&
    config?.User === `${spec.uid}:${spec.gid}` &&
    config.WorkingDir === "/workspace" &&
    JSON.stringify(config.Entrypoint) ===
      JSON.stringify(["/usr/local/bin/node"]) &&
    JSON.stringify(config.Cmd) === JSON.stringify(expectedCommand) &&
    mounts?.length === 2 &&
    mounts.some(
      (mount) =>
        mount.Type === "bind" &&
        mount.Source === spec.workspace &&
        mount.Destination === "/workspace" &&
        mount.RW === true,
    ) &&
    mounts.some(
      (mount) =>
        mount.Type === "bind" &&
        mount.Source === spec.sessionDirectory &&
        mount.Destination === "/opt/oxagen/session" &&
        mount.RW === false,
    );
  if (!safe)
    throw new Error(
      "Docker did not provide the required containment profile; the agent was not started",
    );
  return {
    profile: CONTAINED_PROFILE,
    containerId: value.Id as string,
    imageDigest: spec.image,
    configurationDigest: `sha256:${createHash("sha256").update(configuration).digest("hex")}`,
    gatewayOnlyEgress: true,
    workspaceOnlyWrites: true,
    readOnlyHooks: true,
  };
}
