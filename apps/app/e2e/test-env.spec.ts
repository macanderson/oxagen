import { test, expect } from "@playwright/test";
test("check env", async () => {
  console.log("DATABASE_URL in worker:", process.env.DATABASE_URL?.slice(0, 50));
  console.log("BETTER_AUTH_SECRET in worker:", process.env.BETTER_AUTH_SECRET?.slice(0, 15) + "...");
  expect(1).toBe(1);
});
