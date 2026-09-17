import { expect, it } from "vitest";
import { handle } from "./delegate";

it("answers 404 for a non-member", async () => {
  const res = await handle(
    new Request("http://x"),
    { org: "o", ws: "w" },
    {
      resolveViewer: async () => ({ kind: "not_found" }),
    },
  );
  expect(res.status).toBe(404);
});
