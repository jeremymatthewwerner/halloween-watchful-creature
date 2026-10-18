import { describe, expect, it } from "vitest";
import { BIG_GROUP_SIZE, LINE_GROWS, bigGroupNote, bigGroupPlan, groupSize, isBigGroup, visionCount } from "../web/bigGroup.ts";

describe("big-group mode", () => {
  it("starts at four visitors, or a group that has grown twice this visit (a line forming)", () => {
    expect(BIG_GROUP_SIZE).toBe(4);
    expect(LINE_GROWS).toBe(2);
    expect(isBigGroup(3)).toBe(false);
    expect(isBigGroup(4)).toBe(true);
    expect(isBigGroup(7)).toBe(true);
    expect(isBigGroup(0)).toBe(false);
    expect(isBigGroup(2, 1)).toBe(false);
    expect(isBigGroup(2, 2)).toBe(true);
  });

  it("reads a stated head count from the vision description, in words or digits", () => {
    expect(visionCount("Four visitors close to the decoration. One in a witch hat, standout: a purple broom.")).toBe(4);
    expect(visionCount("5 people: a dinosaur, a ghost, ...")).toBe(5);
    expect(visionCount("Three costumed kids near the bowl.")).toBe(3);
    expect(visionCount("Six trick-or-treaters. Two visitors on the left in capes.")).toBe(6);
    expect(visionCount("One visitor in a green dinosaur costume with a sparkly tail.")).toBeNull();
    expect(visionCount("Too dark or blurry to make out any costumes.")).toBeNull();
  });

  it("lets vision raise the tracker's count but never lower it", () => {
    expect(groupSize(2, "Five visitors: ...")).toBe(5);
    expect(groupSize(5, "Two visitors: ...")).toBe(5);
    expect(groupSize(3, "One visitor in a cape.")).toBe(3);
    expect(groupSize(3, null)).toBe(3);
  });

  it("asks for a group welcome, a shout-out or two and a group moment, and no mini-game", () => {
    for (const plan of [bigGroupPlan(), bigGroupPlan(true)]) {
      expect(plan).toContain("don't go costume by costume");
      expect(plan).toContain("one or two");
      expect(plan).toContain('"trick or treat!"');
      expect(plan).toContain("Don't start a mini-game");
    }
    expect(bigGroupPlan(true)).toContain("newcomers");
  });

  it("notes the group's size for the conversation log", () => {
    expect(bigGroupNote(5)).toBe("big group (5)");
    expect(bigGroupNote(3, 2)).toBe("big group (3): a line is forming");
    expect(bigGroupNote(6, 2)).toBe("big group (6)");
  });
});
