import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../infra/tools/node/ensure-caddy-memory.py", import.meta.url));

function scenario(body: string): string {
  return execFileSync("python3", ["-c", `
import importlib.util, subprocess, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("caddy_memory", ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
state = {"pid":123,"running":True,"memory":0,"swap":0}
updates = []
def update(args, **kwargs):
    updates.append(args)
    state.update(memory=m.LIMIT, swap=m.LIMIT)
m.inspect = lambda: dict(state)
m.memory_used = lambda pid: 30 * 1024 * 1024
m.subprocess.run = update
${body}
`], { encoding: "utf8" });
}

describe("Caddy memory budget", () => {
  it("reads the process cgroup and refuses invalid accounting paths", () => {
    expect(scenario(`
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    proc = root / "proc/123/cgroup"
    proc.parent.mkdir(parents=True)
    group = root / "sys/fs/cgroup/system.slice/docker.scope"
    group.mkdir(parents=True)
    (group / "memory.current").write_text("31457280\\n")
    proc.write_text("0::/system.slice/docker.scope\\n")
    spec2 = importlib.util.spec_from_file_location("caddy_accounting", ${JSON.stringify(script)})
    accounting = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(accounting)
    accounting.Path = lambda name: root / str(name).lstrip("/")
    assert accounting.memory_used(123) == 31457280
    proc.write_text("0::/../../outside\\n")
    try:
        accounting.memory_used(123)
        raise AssertionError("expected invalid cgroup refusal")
    except RuntimeError:
        pass
print("verified")
`)).toContain("verified");
  });

  it("sets and verifies a hard limit with no swap and is idempotent", () => {
    expect(scenario(`
m.main()
m.main()
assert len(updates) == 1
assert updates[0] == ["docker", "update", "--memory", str(m.LIMIT), "--memory-swap", str(m.LIMIT), "oxagen-caddy"]
print("verified")
`)).toContain("verified");
  });

  it("refuses to shrink a busy proxy before invoking Docker update", () => {
    expect(scenario(`
m.memory_used = lambda pid: m.LIMIT * 3 // 4 + 1
try:
    m.main()
    raise AssertionError("expected refusal")
except RuntimeError as error:
    assert "Drain proxy load" in str(error)
assert updates == []
print("refused")
`)).toContain("refused");
  });

  it("does not treat missing accounting or a stopped proxy as safe", () => {
    expect(scenario(`
state["running"] = False
try:
    m.main()
    raise AssertionError("expected refusal")
except RuntimeError:
    pass
state["running"] = True
def unavailable(pid):
    raise OSError("cgroup disappeared")
m.memory_used = unavailable
try:
    m.main()
    raise AssertionError("expected accounting failure")
except OSError:
    pass
assert updates == []
print("refused")
`)).toContain("refused");
  });

  it("fails when Docker refuses or does not apply the limit", () => {
    expect(scenario(`
def ignored(args, **kwargs):
    return None
m.subprocess.run = ignored
try:
    m.main()
    raise AssertionError("expected verification failure")
except RuntimeError as error:
    assert "did not apply" in str(error)
def failed(args, **kwargs):
    raise subprocess.CalledProcessError(1, args)
m.subprocess.run = failed
try:
    m.main()
    raise AssertionError("expected update failure")
except subprocess.CalledProcessError:
    pass
print("refused")
`)).toContain("refused");
  });
});
