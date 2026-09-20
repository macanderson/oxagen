// The three commands a Fleet row sends, and the guard the server action runs
// before the kernel. `steer` and `message` are the two the contract accepts
// that a row must not send: both require a payload, so reaching the kernel
// from a row would come back as a schema refusal with no field to point at.
import { describe, expect, it } from "vitest";
import { isRowCommand, ROW_COMMANDS } from "./row-commands";

describe("ROW_COMMANDS", () => {
  it("is pause, resume and cancel, in the order the row draws them", () => {
    expect(ROW_COMMANDS).toEqual(["pause", "resume", "cancel"]);
  });
});

describe("isRowCommand", () => {
  it("admits each of the three", () => {
    for (const command of ROW_COMMANDS)
      expect(isRowCommand(command)).toBe(true);
  });

  it("refuses the two commands that carry a payload (negative)", () => {
    expect(isRowCommand("steer")).toBe(false);
    expect(isRowCommand("message")).toBe(false);
  });

  it("refuses a word no command vocabulary holds (negative)", () => {
    expect(isRowCommand("")).toBe(false);
    expect(isRowCommand("Pause")).toBe(false);
    expect(isRowCommand("stop")).toBe(false);
  });
});
