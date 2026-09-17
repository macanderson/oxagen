import { expect, it } from "vitest";
import { nextTheme } from "@/features/shell/theme";

it("cycles the theme", () => {
  expect(nextTheme("light")).toBe("dark");
});
