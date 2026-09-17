import { expect, it } from "vitest";
import { handle } from "./delegate";

it("answers a member", async () => {
  const res = await handle(
    new Request("http://x"),
    { org: "o", ws: "w" },
    {
      resolveViewer: async () => ({ kind: "ok" }),
    },
  );
  expect(res.status).toBe(200);
});
