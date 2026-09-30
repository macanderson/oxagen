// mcp-single-instance.test.ts: production runs one MCP process (#4773).
//
// A local tool call waits in the MCP process's broker until the machine's
// long-poll picks it up (apps/mcp/src/local-servers/broker.ts). The broker
// lives in memory, so the call and the poll meet only when one process
// serves mcp.oxagen.sh. Each assertion below reads one fact that keeps it at
// one. When a change breaks one, the change also has to give the broker a
// shared queue, or local calls read "disconnected" whenever the poll and the
// call land on different instances.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** The body of the first `{ ... }` block that starts at `from`, braces balanced. */
function blockAt(text: string, from: number): string {
  const open = text.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error("unbalanced block");
}

function countOf(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

describe("the MCP service runs as one process in production", () => {
  it("runs on one app node, with no count or for_each on it", () => {
    const stack = read("infra/stacks-new/oxagen/main.tf");
    const nodes = [...stack.matchAll(/module "([\w-]+)" \{/g)].filter((m) =>
      blockAt(stack, m.index).includes('"../../modules/app-node"'),
    );
    expect(nodes).toHaveLength(1);
    for (const m of nodes) expect(blockAt(stack, m.index)).not.toMatch(/^\s*(count|for_each)\s*=/m);

    const node = read("infra/modules/app-node/main.tf");
    const instances = [...node.matchAll(/resource "aws_instance" "\w+" \{/g)];
    expect(instances).toHaveLength(1);
    for (const m of instances) expect(blockAt(node, m.index)).not.toMatch(/^\s*(count|for_each)\s*=/m);
  });

  it("puts the app node behind the load balancer once, with no scaling group", () => {
    const stack = read("infra/stacks-new/oxagen/main.tf");
    expect(countOf(stack, /resource "aws_lb_target_group_attachment"/g)).toBe(1);
    for (const path of ["infra/stacks-new/oxagen/main.tf", "infra/modules/app-node/main.tf"]) {
      expect(read(path)).not.toMatch(/resource "(aws_autoscaling_group|aws_ecs_service)"/);
    }
  });

  it("sends mcp.oxagen.sh to one upstream on the node", () => {
    const caddy = read("infra/tools/caddy/Caddyfile.alb");
    const handle = caddy.indexOf("handle @mcp");
    expect(handle).toBeGreaterThan(-1);
    const body = blockAt(caddy, handle);
    const upstreams = [...body.matchAll(/reverse_proxy\s+([^{\n]+)/g)].map((m) => (m[1] ?? "").trim().split(/\s+/));
    expect(upstreams).toEqual([["127.0.0.1:4100"]]);
  });

  it("replaces the service's one container on each deploy", () => {
    const deploy = read("infra/tools/node/deploy-service.sh");
    expect(deploy).toContain('docker rm -f "$CONTAINER"');
    expect(countOf(deploy, /docker run -d/g)).toBe(1);
    expect(deploy).toMatch(/docker run -d \\\n\s+--name "\$CONTAINER"/);
  });

  it("deploys mcp from one pipeline entry and nowhere else", () => {
    const pipeline = read(".github/workflows/pipeline.yml");
    expect(countOf(pipeline, /^\s*- service: mcp$/gm)).toBe(1);
    expect(existsSync(join(root, "apps/mcp/vercel.json"))).toBe(false);
  });
});
