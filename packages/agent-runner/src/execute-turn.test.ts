/**
 * Integration coverage for the executeTurn seam: prompt → engine → tool
 * execution → events → result, driven exactly the way a platform surface
 * drives it.
 *
 * The engine is Stella, so this stands up a fake `stella-serve` speaking the
 * real reverse-RPC protocol and driving the real state machine: ask for a model
 * call, wait for the host's `provider-result`, turn the tool call in that result
 * into a `tool_request`, wait for the host's `tool-result`, ask for one more
 * model call, complete. Nothing on the host side is mocked — the tool really
 * executes against the workspace, because that is the property worth
 * protecting.
 *
 * The distinction this pins down: the AI SDK will execute tools itself if it is
 * allowed to, and it must not here — the model only PROPOSES a call and the
 * engine dispatches it. A regression letting the SDK execute again would show
 * up as the edit happening without the sidecar ever issuing a `tool_request`,
 * which the frame log below asserts directly.
 */
import {
  createServer,
  type Server,
  type ServerResponse,
  type IncomingMessage,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryWorkspace,
  type AgentAi,
  type ModelRunArgs,
} from "@oxagen/agent-engine";
import { StellaSidecarClient } from "@oxagen/stella-engine-client";
import { executeTurn, executePipelineTurn, type CodingEvent } from "./index";

interface FakeSidecar {
  url: string;
  close(): Promise<void>;
  /** Every reverse request the engine issued, in order. */
  issued: string[];
}

/** Only the fields this fake reacts to; everything else rides through unread. */
interface PostedBody {
  result?: {
    text?: string;
    tool_calls?: Array<{ name: string; input: Record<string, unknown> }>;
  };
}

function readBody(req: IncomingMessage): Promise<PostedBody> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw ? (JSON.parse(raw) as PostedBody) : {}));
  });
}

function startFakeSidecar(): Promise<FakeSidecar> {
  const issued: string[] = [];
  let streamRes: ServerResponse | undefined;
  let server: Server;

  const send = (frame: unknown) => {
    streamRes?.write(`data: ${JSON.stringify(frame)}\n\n`);
  };
  const ok = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? "";

      if (url.includes("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        streamRes = res; // held open; frames are pushed as the host answers
        issued.push("provider_request");
        send({
          seq: 1,
          type: "provider_request",
          request_id: "prov-1",
          provider_id: "oxagen",
          role: "worker",
          request: {
            messages: [{ role: "user", content: "rename foo to bar" }],
          },
        });
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }

      void readBody(req).then((body) => {
        if (url === "/v1/turns") return ok(res, { turn_id: "turn-fake" });

        ok(res, { status: "ok" });

        if (url.includes("/provider-result")) {
          const [call] = body?.result?.tool_calls ?? [];
          if (call) {
            issued.push("tool_request");
            send({
              seq: 2,
              type: "tool_request",
              request_id: "tool-1",
              name: call.name,
              input: call.input,
            });
          } else {
            send({
              seq: 4,
              type: "turn_complete",
              outcome: {
                status: "completed",
                text: body?.result?.text ?? "",
                cost_usd: 0,
              },
            });
          }
          return;
        }

        if (url.includes("/tool-result")) {
          issued.push("provider_request");
          send({
            seq: 3,
            type: "provider_request",
            request_id: "prov-2",
            provider_id: "oxagen",
            role: "worker",
            request: {
              messages: [{ role: "user", content: "rename foo to bar" }],
            },
          });
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        issued,
        close: () =>
          new Promise((r) => {
            streamRes?.end();
            server.close(() => r());
          }),
      });
    });
  });
}

/**
 * A model that PROPOSES an edit rather than performing one. Under Stella the
 * engine dispatches the call, so a tool executing here would mean the SDK had
 * bypassed the engine entirely.
 */
function makeProposingAi(): AgentAi {
  let call = 0;
  return {
    stream(args: ModelRunArgs) {
      const first = call++ === 0;
      // The bridge strips `execute` before handing tools to the SDK. Assert it:
      // a leak here is exactly what would silently double-run every tool.
      const edit = args.tools["edit_file"] as { execute?: unknown } | undefined;
      if (edit && edit.execute !== undefined) {
        throw new Error(
          "tool definitions reached the model with execute attached",
        );
      }
      return {
        fullStream: (async function* () {
          if (!first) yield { type: "text-delta", text: "done" };
        })(),
        toolCalls: Promise.resolve(
          first
            ? [
                {
                  toolCallId: "call-1",
                  toolName: "edit_file",
                  input: { path: "a.ts", old_string: "foo", new_string: "bar" },
                },
              ]
            : [],
        ),
        steps: Promise.resolve([{}]),
        usage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        }),
        response: Promise.resolve({ modelId: "test-model", messages: [] }),
        finishReason: Promise.resolve("stop"),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    generateObject: async () =>
      ({ object: {} as never, usage: { totalTokens: 0 } }) as never,
  };
}

let sidecar: FakeSidecar | undefined;
afterEach(async () => {
  await sidecar?.close();
  sidecar = undefined;
});

describe("executeTurn — the production chat path, on Stella", () => {
  it("runs prompt → engine → tool → events → result through the seam", async () => {
    sidecar = await startFakeSidecar();
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    const events: CodingEvent[] = [];

    const result = await executeTurn(
      "chat",
      {
        workspace: ws,
        ai: makeProposingAi(),
        instruction: "rename foo to bar",
        onEvent: (e) => events.push(e),
      },
      { client: new StellaSidecarClient({ baseUrl: sidecar.url, token: "t" }) },
    );

    // The ENGINE dispatched the tool — not the AI SDK.
    expect(sidecar.issued).toEqual([
      "provider_request",
      "tool_request",
      "provider_request",
    ]);

    // The turn's answer and the applied edit both came back through the seam.
    // (MemoryWorkspace.diff() is header-only by contract, so the edit itself is
    // asserted against the workspace content.)
    expect(result.text).toBe("done");
    expect(result.changedFiles).toEqual(["a.ts"]);
    expect(result.diff).toContain("a/a.ts");
    expect(await ws.readFile("a.ts")).toBe("bar");

    // Usage accumulated across BOTH model calls, not just the last.
    expect(result.usage.inputTokens).toBe(2);
    expect(result.steps).toBe(2);

    // The event stream observed the real tool execution and the final diff.
    expect(events.some((e) => e.type === "file-edit")).toBe(true);
    expect(events.some((e) => e.type === "final-diff")).toBe(true);
  });

  it("fails loudly when no sidecar is configured rather than falling back to another engine", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    await expect(
      executeTurn("chat", {
        workspace: ws,
        ai: makeProposingAi(),
        instruction: "x",
      }),
    ).rejects.toThrow(/Stella engine is not configured/);
  });
});
describe("executePipelineTurn — judged pipeline (the repo-edit path)", () => {
  it("runs the full evaluate→execute→judge pipeline through the seam", async () => {
    const ai: AgentAi = {
      stream() {
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "pipeline done" };
          })(),
          steps: Promise.resolve([{}]),
          usage: Promise.resolve({
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
          response: Promise.resolve({ messages: [] }),
          finishReason: Promise.resolve("stop"),
        } as unknown as ReturnType<AgentAi["stream"]>;
      },
      generateObject: (args: { system?: string }) => {
        if (args.system?.includes("evaluation stage")) {
          return Promise.resolve({
            object: {
              completeness: 70,
              complexity: 40,
              recommendedTier: "balanced",
              missing: [],
              contextQueries: [],
              refinedPrompt: "refined prompt",
              removed: [],
              reasoning: "well scoped",
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          }) as never;
        }
        // Judge branch: always complete — no revise round in this smoke test.
        return Promise.resolve({
          object: {
            complete: true,
            confidence: 90,
            findings: [],
            remainingWork: [],
            reasoning: "looks done",
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        }) as never;
      },
    };

    const result = await executePipelineTurn("repo-edit", {
      prompt: "say done",
      workspace: new MemoryWorkspace({}),
      ai,
    });

    expect(result.text).toBe("pipeline done");
    expect(result.trace).toBeDefined();
  });
});
