import { describe, expect, it } from "vitest";
import { isTimeZone, timeZoneChoices } from "./time-zone";

describe("isTimeZone", () => {
  it("accepts an IANA zone and UTC", () => {
    expect(isTimeZone("America/Los_Angeles")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
  });

  it("refuses a name Intl cannot format in (negative)", () => {
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("timeZoneChoices", () => {
  it("lists the runtime's zones, with the stored one among them", () => {
    const choices = timeZoneChoices("America/Los_Angeles");
    expect(choices).toContain("America/Los_Angeles");
    expect(choices).toContain("Europe/London");
    expect(choices.indexOf("America/Los_Angeles")).toBe(
      choices.lastIndexOf("America/Los_Angeles"),
    );
  });

  it("keeps a stored zone the list does not carry, first, so the select shows what is stored", () => {
    const choices = timeZoneChoices("US/Pacific");
    expect(choices[0]).toBe("US/Pacific");
    expect(choices.filter((z) => z === "US/Pacific")).toHaveLength(1);
  });
});
