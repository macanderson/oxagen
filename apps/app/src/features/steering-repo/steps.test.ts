// The provisioning steps a person sees, derived from the last step that
// finished and the step that failed or stopped. The job skips
// `bind_repository` for an organization, `add_to_installation` on GitLab, and
// `register_webhook` on GitHub, so the list leaves those out.
import { describe, expect, it } from "vitest";
import { provisioningSteps } from "./steps";
import type { SteeringRepoView } from "./types";

type Progress = Pick<
  SteeringRepoView,
  "status" | "step" | "failedStep" | "provider"
>;

function states(view: Progress, ws: string | null = "core-platform") {
  return provisioningSteps(view, ws).map(({ step, state }) => [step, state]);
}

describe("the provisioning steps", () => {
  it("marks every step done once the repo is ready", () => {
    expect(
      states({
        status: "ready",
        step: "bind_repository",
        failedStep: null,
        provider: "github",
      }),
    ).toEqual([
      ["pick_connection", "done"],
      ["create_repository", "done"],
      ["add_to_installation", "done"],
      ["write_first_commit", "done"],
      ["apply_settings", "done"],
      ["publish_version", "done"],
      ["bind_repository", "done"],
    ]);
  });

  it("runs the step after the last one that finished and leaves the rest waiting", () => {
    expect(
      states({
        status: "provisioning",
        step: "create_repository",
        failedStep: null,
        provider: "github",
      }),
    ).toEqual([
      ["pick_connection", "done"],
      ["create_repository", "done"],
      ["add_to_installation", "running"],
      ["write_first_commit", "waiting"],
      ["apply_settings", "waiting"],
      ["publish_version", "waiting"],
      ["bind_repository", "waiting"],
    ]);
  });

  it("runs the first step before any step finished", () => {
    expect(
      states({
        status: "provisioning",
        step: null,
        failedStep: null,
        provider: null,
      })[0],
    ).toEqual(["pick_connection", "running"]);
  });

  it("marks the step that failed, whatever step comes next", () => {
    expect(
      states({
        status: "failed",
        step: "write_first_commit",
        failedStep: "apply_settings",
        provider: "github",
      }),
    ).toEqual([
      ["pick_connection", "done"],
      ["create_repository", "done"],
      ["add_to_installation", "done"],
      ["write_first_commit", "done"],
      ["apply_settings", "failed"],
      ["publish_version", "waiting"],
      ["bind_repository", "waiting"],
    ]);
  });

  it("marks the next step blocked when the job stopped without naming one", () => {
    expect(
      states({
        status: "blocked",
        step: "create_repository",
        failedStep: null,
        provider: "github",
      })[2],
    ).toEqual(["add_to_installation", "blocked"]);
  });

  it("leaves out the installation step on GitLab and runs the step after it", () => {
    expect(
      states({
        status: "provisioning",
        step: "create_repository",
        failedStep: null,
        provider: "gitlab",
      }),
    ).toEqual([
      ["pick_connection", "done"],
      ["create_repository", "done"],
      ["write_first_commit", "running"],
      ["apply_settings", "waiting"],
      ["register_webhook", "waiting"],
      ["publish_version", "waiting"],
      ["bind_repository", "waiting"],
    ]);
  });

  it("marks the hook step failed on GitLab", () => {
    expect(
      states({
        status: "failed",
        step: "apply_settings",
        failedStep: "register_webhook",
        provider: "gitlab",
      }),
    ).toEqual([
      ["pick_connection", "done"],
      ["create_repository", "done"],
      ["write_first_commit", "done"],
      ["apply_settings", "done"],
      ["register_webhook", "failed"],
      ["publish_version", "waiting"],
      ["bind_repository", "waiting"],
    ]);
  });

  it("keeps the installation step while no connection is picked, as GitHub is the default host", () => {
    expect(
      states({
        status: "provisioning",
        step: null,
        failedStep: null,
        provider: null,
      }).map(([step]) => step),
    ).toContain("add_to_installation");
  });

  it("leaves out the workspace binding for an organization's repo", () => {
    expect(
      states(
        {
          status: "ready",
          step: "publish_version",
          failedStep: null,
          provider: "gitlab",
        },
        null,
      ),
    ).toEqual([
      ["pick_connection", "done"],
      ["create_repository", "done"],
      ["write_first_commit", "done"],
      ["apply_settings", "done"],
      ["register_webhook", "done"],
      ["publish_version", "done"],
    ]);
  });

  it("runs the project hook step after the settings on GitLab and leaves it out on GitHub", () => {
    const afterSettings = {
      status: "provisioning",
      step: "apply_settings",
      failedStep: null,
    } as const;
    expect(states({ ...afterSettings, provider: "gitlab" })).toEqual([
      ["pick_connection", "done"],
      ["create_repository", "done"],
      ["write_first_commit", "done"],
      ["apply_settings", "done"],
      ["register_webhook", "running"],
      ["publish_version", "waiting"],
      ["bind_repository", "waiting"],
    ]);
    expect(states({ ...afterSettings, provider: "github" })).toEqual([
      ["pick_connection", "done"],
      ["create_repository", "done"],
      ["add_to_installation", "done"],
      ["write_first_commit", "done"],
      ["apply_settings", "done"],
      ["publish_version", "running"],
      ["bind_repository", "waiting"],
    ]);
    // A connection not yet picked reads as GitHub, the default host.
    expect(
      states({ ...afterSettings, step: null, provider: null }).map(
        ([step]) => step,
      ),
    ).not.toContain("register_webhook");
  });
});
