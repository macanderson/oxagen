import { describe, expect, it } from "vitest";
import {
  containerArguments,
  measureContainer,
  type ContainedLaunchSpec,
} from "./profile";

const spec: ContainedLaunchSpec = {
  name: `oxagen-contained-${"a".repeat(32)}`,
  image: `sha256:${"b".repeat(64)}`,
  workspace: "/srv/repository",
  sessionDirectory: "/run/oxagen/session",
  uid: 1000,
  gid: 1000,
  harness: "claude-code",
  args: ["-p", "Fix the failing test"],
};
function inspection() {
  return {
    Id: "c".repeat(64),
    Image: spec.image,
    Config: {
      User: "1000:1000",
      WorkingDir: "/workspace",
      Entrypoint: ["/usr/local/bin/node"],
      Cmd: ["/opt/oxagen/entry.mjs", spec.harness, ...spec.args],
    },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidMode: "",
      IpcMode: "private",
      UsernsMode: "",
      CgroupnsMode: "private",
      Devices: [],
      DeviceRequests: null,
    },
    Mounts: [
      {
        Type: "bind",
        Source: spec.workspace,
        Destination: "/workspace",
        RW: true,
      },
      {
        Type: "bind",
        Source: spec.sessionDirectory,
        Destination: "/opt/oxagen/session",
        RW: false,
      },
    ],
  };
}

describe("contained Docker profile", () => {
  it("pins the image, disables networking and mounts only the workspace writable", () => {
    const args = containerArguments(spec);
    expect(
      args.slice(args.indexOf("--network"), args.indexOf("--network") + 2),
    ).toEqual(["--network", "none"]);
    expect(args).toContain("--read-only");
    expect(args.filter((arg) => arg.startsWith("type=bind"))).toEqual([
      "type=bind,src=/srv/repository,dst=/workspace",
      "type=bind,src=/run/oxagen/session,dst=/opt/oxagen/session,readonly",
    ]);
    expect(args.slice(-5)).toEqual([
      spec.image,
      "/opt/oxagen/entry.mjs",
      "claude-code",
      ...spec.args,
    ]);
  });

  it.each([
    { uid: 0 },
    { gid: -1 },
    { image: "node:latest" },
    { workspace: "/repo,readonly=false" },
    { sessionDirectory: "relative" },
    { name: "arbitrary" },
  ])("refuses an unsafe launch input %j", (override) => {
    expect(() => containerArguments({ ...spec, ...override })).toThrow();
  });

  it("measures the actual created container before recording containment", () => {
    expect(measureContainer(inspection(), spec, '{"hooks":[]}')).toMatchObject({
      profile: "oxagen-linux-docker-v1",
      containerId: "c".repeat(64),
      imageDigest: spec.image,
      configurationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      gatewayOnlyEgress: true,
      workspaceOnlyWrites: true,
      readOnlyHooks: true,
    });
  });

  it.each([
    { NetworkMode: "host" },
    { ReadonlyRootfs: false },
    { Privileged: true },
    { CapAdd: ["SYS_ADMIN"] },
    { CapDrop: [] },
    { SecurityOpt: [] },
    { PidMode: "host" },
    { PidMode: "container:other" },
    { IpcMode: "host" },
    { IpcMode: "container:other" },
    { UsernsMode: "host" },
    { CgroupnsMode: "host" },
    { Devices: [{}] },
    { DeviceRequests: [{}] },
  ])(
    "refuses Docker controls that differ from the requested profile %j",
    (override) => {
      const actual = inspection();
      expect(() =>
        measureContainer(
          { ...actual, HostConfig: { ...actual.HostConfig, ...override } },
          spec,
          "{}",
        ),
      ).toThrow("not started");
    },
  );

  it("refuses extra mounts, writable hook configuration, and an altered command", () => {
    const actual = inspection();
    expect(() =>
      measureContainer(
        {
          ...actual,
          Mounts: [
            ...actual.Mounts,
            { Type: "bind", Source: "/", Destination: "/host", RW: false },
          ],
        },
        spec,
        "{}",
      ),
    ).toThrow();
    expect(() =>
      measureContainer(
        {
          ...actual,
          Mounts: actual.Mounts.map((mount) => ({ ...mount, RW: true })),
        },
        spec,
        "{}",
      ),
    ).toThrow();
    expect(() =>
      measureContainer(
        { ...actual, Config: { ...actual.Config, Cmd: ["sh"] } },
        spec,
        "{}",
      ),
    ).toThrow();
    expect(() => measureContainer(undefined, spec, "{}")).toThrow();
  });
});
