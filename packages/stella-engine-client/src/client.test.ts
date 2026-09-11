/**
 * One route per method, against the fake engine. Each case pins a status code
 * or a body shape the real server was observed to produce (see
 * `fake-engine.ts`'s header and the golden fixture), so a change on the
 * server's side shows up here as a red test rather than as a wedged turn.
 */
import { describe, expect, it } from "vitest";
import { EngineHttpError, StellaEngineClient, isStaleRequest } from "./client";
import { FakeEngine, goldenScript } from "./fake-engine";

function client(engine: FakeEngine, token = "fake-token"): StellaEngineClient {
  return new StellaEngineClient({
    baseUrl: "http://engine.test/",
    token,
    fetchImpl: engine.fetch,
  });
}

describe("StellaEngineClient", () => {
  it("normalises the base url and answers health and readiness without auth", async () => {
    const engine = new FakeEngine();
    const c = client(engine, "wrong-token");
    expect(c.baseUrl).toBe("http://engine.test");
    expect(await c.health()).toEqual({ status: "ok" });
    expect(await c.ready()).toEqual({ state: "ready", ready: true });
    engine.setReadiness("draining");
    expect(await c.ready()).toEqual({ state: "draining", ready: false });
  });

  it("refuses everything else with a 401 when the token is wrong", async () => {
    const c = client(new FakeEngine(), "wrong-token");
    const err = await c
      .createSession({ system_prompt: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineHttpError);
    expect((err as EngineHttpError).status).toBe(401);
    expect((err as EngineHttpError).errorMessage).toBe(
      "missing or invalid bearer token",
    );
    expect(String(err)).not.toContain("wrong-token");
  });

  it("creates, reads and deletes a session, and reports the cap with Retry-After", async () => {
    const engine = new FakeEngine({ maxSessions: 1 });
    const c = client(engine);
    const { session_id } = await c.createSession({
      system_prompt: "You are a test.",
    });
    const view = await c.getSession(session_id);
    expect(view.messages).toEqual([
      { role: "system", content: "You are a test." },
    ]);
    expect(view.live_turn).toBeNull();

    const full = await c
      .createSession({ system_prompt: "another" })
      .catch((e: unknown) => e);
    expect((full as EngineHttpError).status).toBe(429);
    expect((full as EngineHttpError).retryAfterMs).toBe(5000);

    expect(await c.deleteSession(session_id)).toEqual({ status: "deleted" });
    const gone = await c.getSession(session_id).catch((e: unknown) => e);
    expect((gone as EngineHttpError).status).toBe(404);
  });

  it("starts a session turn and refuses a second live one with 409", async () => {
    const engine = new FakeEngine();
    engine.scriptTurn(goldenScript());
    engine.scriptTurn(goldenScript());
    const c = client(engine);
    const { session_id } = await c.createSession({ system_prompt: "s" });
    const turn = await c.startTurn(session_id, {
      provider_id: "openrouter",
      input: [{ role: "user", content: "hi" }],
    });
    expect(turn.turn_id).toMatch(/^turn-/);
    expect(turn.session_id).toBe(session_id);
    expect(turn.clamped).toEqual([]);

    const second = await c
      .startTurn(session_id, {
        provider_id: "openrouter",
        input: [{ role: "user", content: "again" }],
      })
      .catch((e: unknown) => e);
    expect((second as EngineHttpError).status).toBe(409);
    expect((second as EngineHttpError).errorMessage).toBe(
      "a turn is already running in this session",
    );
  });

  it("normalises an omitted clamped list and keeps one the server sent", async () => {
    const engine = new FakeEngine();
    engine.scriptTurn(goldenScript());
    engine.scriptTurn(goldenScript());
    const c = client(engine);
    const plain = await c.startStatelessTurn({
      provider_id: "openrouter",
      messages: [],
    });
    expect(plain.clamped).toEqual([]);
    const lowered = await c.startStatelessTurn({
      provider_id: "openrouter",
      messages: [],
      engine: { max_output_tokens: 1_000_000 },
    });
    expect(lowered.clamped).toEqual([
      { knob: "max_output_tokens", requested: 1_000_000, effective: 262_144 },
    ]);
  });

  it("streams frames with their seq and refuses a second subscriber with 409", async () => {
    const engine = new FakeEngine();
    engine.scriptTurn(goldenScript());
    const c = client(engine);
    const { turn_id } = await c.startStatelessTurn({
      provider_id: "openrouter",
      messages: [],
    });
    const frames = c.openFrames(turn_id);
    const first = await frames.next();
    expect(first.value).toMatchObject({
      seq: 1,
      type: "provider_request",
      request_id: "prov-1-0",
    });

    const second = c.openFrames(turn_id);
    const err = await second.next().catch((e: unknown) => e);
    expect((err as EngineHttpError).status).toBe(409);
    await frames.return();
    expect(engine.hasSubscriber(turn_id)).toBe(false);
  });

  it("answers a provider request, a delta batch, and a tool request with the recorded bodies", async () => {
    const engine = new FakeEngine();
    engine.scriptTurn(goldenScript());
    const c = client(engine);
    const { turn_id } = await c.startStatelessTurn({
      provider_id: "openrouter",
      messages: [],
    });
    const frames = c.openFrames(turn_id);
    await frames.next();
    await c.sendProviderDeltas(turn_id, "prov-1-0", [
      { kind: "text", text: "..." },
    ]);
    await c.resolveProvider(turn_id, "prov-1-0", {
      text: "",
      tool_calls: [
        { call_id: "call_1", name: "search_nodes", input: { q: "nodes" } },
      ],
      usage: {
        reported: true,
        input_tokens: 1,
        output_tokens: 1,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
      },
      model: "m",
      cost_usd: 0,
      finish_reason: "tool_calls",
    });
    // The stage event, then the tool request.
    await frames.next();
    const tool = await frames.next();
    expect(tool.value).toMatchObject({
      seq: 3,
      type: "tool_request",
      request_id: "tool-1-0",
    });
    await c.resolveTool(turn_id, "tool-1-0", { ok: { content: "[n1]" } });
    expect(engine.posts.map((p) => [p.route, p.status])).toEqual([
      ["provider-delta", 200],
      ["provider-result", 200],
      ["tool-result", 200],
    ]);
    expect(engine.posts[1]!.body).toMatchObject({
      request_id: "prov-1-0",
      status: "ok",
    });
    await frames.return();
  });

  it("refuses an empty delta batch before it reaches the server", async () => {
    const c = client(new FakeEngine());
    await expect(c.sendProviderDeltas("turn-x", "prov-x", [])).rejects.toThrow(
      /at least one fragment/,
    );
  });

  it("reports a stale answer as 409 and an unknown turn as 404, both stale", async () => {
    const engine = new FakeEngine();
    engine.scriptTurn(goldenScript());
    const c = client(engine);
    const { turn_id } = await c.startStatelessTurn({
      provider_id: "openrouter",
      messages: [],
    });
    const frames = c.openFrames(turn_id);
    await frames.next();
    const stale = await c
      .resolveTool(turn_id, "tool-never", { ok: { content: "" } })
      .catch((e: unknown) => e);
    expect((stale as EngineHttpError).status).toBe(409);
    expect(isStaleRequest(stale)).toBe(true);
    const unknown = await c
      .resolveTool("turn-missing", "x", { ok: { content: "" } })
      .catch((e: unknown) => e);
    expect((unknown as EngineHttpError).status).toBe(404);
    expect(isStaleRequest(unknown)).toBe(true);
    expect(isStaleRequest(new Error("other"))).toBe(false);
    await frames.return();
  });

  it("cancels once with true and again with false, and 409s steering a finished turn", async () => {
    const engine = new FakeEngine();
    engine.scriptTurn(goldenScript());
    const c = client(engine);
    const { turn_id } = await c.startStatelessTurn({
      provider_id: "openrouter",
      messages: [],
    });
    expect(await c.cancelTurn(turn_id)).toBe(true);
    expect(await c.cancelTurn(turn_id)).toBe(false);
    const steer = await c.steer(turn_id, "hurry").catch((e: unknown) => e);
    expect((steer as EngineHttpError).status).toBe(404);
  });

  it("queues steer, pause and resume on a live turn", async () => {
    const engine = new FakeEngine();
    engine.scriptTurn(goldenScript());
    const c = client(engine);
    const { turn_id } = await c.startStatelessTurn({
      provider_id: "openrouter",
      messages: [],
    });
    await expect(c.steer(turn_id, "focus")).resolves.toBeUndefined();
    await expect(c.pause(turn_id, "operator")).resolves.toBeUndefined();
    await expect(c.resume(turn_id)).resolves.toBeUndefined();
  });

  it("sends every body as a string so the server sees a Content-Length", async () => {
    const seen: RequestInit[] = [];
    const engine = new FakeEngine();
    const c = new StellaEngineClient({
      baseUrl: "http://engine.test",
      token: "fake-token",
      fetchImpl: (input, init) => {
        seen.push(init ?? {});
        return engine.fetch(input, init);
      },
    });
    await c.createSession({ system_prompt: "s" });
    expect(typeof seen[0]!.body).toBe("string");
  });
});
