import { describe, expect, it } from "vitest";
import { timeZoneChoices } from "./time-zone";

describe("timeZoneChoices", () => {
  it("lists the runtime's zones, with the stored one among them once", () => {
    const choices = timeZoneChoices("America/Los_Angeles");
    expect(choices).toContain("Europe/London");
    expect(choices.filter((z) => z === "America/Los_Angeles")).toHaveLength(1);
  });

  it("keeps a stored zone the list does not carry, first, so the select shows what is stored", () => {
    expect(timeZoneChoices("US/Pacific", ["Europe/London"])).toEqual([
      "US/Pacific",
      "Europe/London",
    ]);
  });

  it("answers the list unchanged when it carries the stored zone", () => {
    expect(timeZoneChoices("Europe/London", ["Europe/London"])).toEqual([
      "Europe/London",
    ]);
  });
});
