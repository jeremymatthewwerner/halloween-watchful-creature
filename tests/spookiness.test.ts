import { describe, expect, it, vi } from "vitest";
import { MODES_CLEARED, MODES_KEY, modeInstructions } from "../web/modes.ts";
import {
  DEFAULT_SPOOKINESS,
  SPOOKY_KEY,
  SPOOKY_LEVELS,
  autoLevel,
  loadSpookiness,
  resolveSpookiness,
  saveSpookiness,
  spookyRules,
} from "../web/spookiness.ts";
import { OperatorStanding, standingInstructions, standingUpdate } from "../web/standing.ts";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

const at = (hour: number, minute = 0) => new Date(2026, 9, 31, hour, minute);

describe("spookiness levels", () => {
  it("has four levels, gentle to scary for teens, with playful as the default", () => {
    expect(SPOOKY_LEVELS.map((l) => l.name)).toEqual(["gentle", "playful", "spooky", "scary"]);
    expect(SPOOKY_LEVELS.map((l) => l.level)).toEqual([0, 1, 2, 3]);
    expect(DEFAULT_SPOOKINESS).toBe(1);
  });

  it("maps each level to its instruction; playful is the creature's normal and adds none", () => {
    expect(spookyRules(1)).toEqual([]);
    expect(spookyRules(0)).toEqual([expect.stringMatching(/gentle.*Nothing scary at all/s)]);
    expect(spookyRules(2)).toEqual([expect.stringMatching(/spooky.*eerie voice.*spooky jokes.*little kid looks unsure/s)]);
    const [teens] = spookyRules(3);
    expect(teens).toMatch(/scary, for teens/);
    expect(teens).toMatch(/never gory, cruel or mean/);
    expect(teens).toMatch(/young child.*scared or says so, switch to gentle/s);
  });

  it("can't push past the hard limits in base.md: scary restates them, and every level keeps the usual rules", () => {
    const [teens] = spookyRules(3);
    expect(teens).toMatch(/never gory, cruel or mean; no jump-scares/);
    for (const level of [0, 2, 3] as const) {
      // Every level starts the way base.md's "Never truly scary" rule refers to it.
      expect(spookyRules(level)[0]).toMatch(/^Spookiness tonight: /);
      expect(standingInstructions([], level)).toContain("Your usual rules still apply.");
    }
  });

  it("uses kid-first wording: short, simple, no French and no chef talk", () => {
    const all = SPOOKY_LEVELS.map((l) => l.rule).join(" ");
    expect(all).not.toMatch(/bonsoir|magnifique|mon ami|ooh la la|chef|kiss|cuisine|palate|recipe|scary voice|blood|gore\b|kill|die/i);
    for (const l of SPOOKY_LEVELS) expect(l.rule.length).toBeLessThan(300);
  });

  it("follows the clock on auto: gentle until 7 pm, playful until 8, spooky until morning, never scary", () => {
    expect(autoLevel(at(17, 30))).toBe(0);
    expect(autoLevel(at(18, 59))).toBe(0);
    expect(autoLevel(at(19, 0))).toBe(1);
    expect(autoLevel(at(19, 59))).toBe(1);
    expect(autoLevel(at(20, 0))).toBe(2);
    expect(autoLevel(at(23, 30))).toBe(2);
    expect(autoLevel(new Date(2026, 10, 1, 0, 30))).toBe(2);
    for (let h = 0; h < 24; h++) expect(autoLevel(at(h))).not.toBe(3);
  });

  it("is held at gentle while Toddler mode is on", () => {
    expect(resolveSpookiness(3, ["toddler"], at(21))).toBe(0);
    expect(resolveSpookiness("auto", ["candyLow", "toddler"], at(21))).toBe(0);
    expect(resolveSpookiness(3, ["candyLow"], at(21))).toBe(3);
    expect(resolveSpookiness("auto", [], at(21))).toBe(2);
  });

  it("joins the quick modes in one set of standing instructions", () => {
    expect(standingInstructions([], 1)).toBe("");
    expect(standingUpdate([], 1)).toBe(MODES_CLEARED);
    expect(standingInstructions(["candyLow"], 1)).toBe(modeInstructions(["candyLow"]));
    const text = standingInstructions(["candyLow"], 3);
    expect(text).toMatch(/^\[OPERATOR\]/);
    expect(text).toContain("replace any earlier standing instructions");
    expect(text.indexOf("scary, for teens")).toBeLessThan(text.indexOf("candy is almost gone"));
    expect(standingInstructions([], 2)).toContain("Spookiness tonight: spooky");
  });

  it("remembers the dial for the evening, past midnight but not into the next day", () => {
    const store = memory();
    saveSpookiness(store, 3, at(21));
    expect(JSON.parse(store.data.get(SPOOKY_KEY)!)).toEqual({ evening: "2026-10-31", choice: 3 });
    expect(loadSpookiness(store, new Date(2026, 10, 1, 1, 0))).toBe(3);
    expect(loadSpookiness(store, new Date(2026, 10, 1, 17, 0))).toBe(DEFAULT_SPOOKINESS);
    saveSpookiness(store, "auto", at(18));
    expect(loadSpookiness(store, at(22))).toBe("auto");
  });

  it("ignores broken or unknown saved dial state", () => {
    const store = memory();
    expect(loadSpookiness(store)).toBe(1);
    store.setItem(SPOOKY_KEY, "{nope");
    expect(loadSpookiness(store)).toBe(1);
    store.setItem(SPOOKY_KEY, JSON.stringify({ evening: "2026-10-31", choice: 11 }));
    expect(loadSpookiness(store, at(21))).toBe(1);
    expect(loadSpookiness(null)).toBe(1);
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadSpookiness(throwing)).toBe(1);
    expect(() => saveSpookiness(throwing, 2)).not.toThrow();
  });
});

describe("OperatorStanding", () => {
  const engine = () => ({ setStanding: vi.fn<(standing: string, change?: string) => void>() });

  it("applies the dial right away to an attached engine, with a change for the open session", () => {
    const store = memory();
    const standing = new OperatorStanding(store, () => at(21));
    const e = engine();
    standing.attach(e);
    expect(e.setStanding).toHaveBeenLastCalledWith("");
    standing.setSpookiness(2);
    expect(standing.spookiness).toBe(2);
    expect(e.setStanding).toHaveBeenLastCalledWith(standingInstructions([], 2), standingUpdate([], 2));
    // Back to playful: the open session hears the earlier instructions are off.
    standing.setSpookiness(1);
    expect(e.setStanding).toHaveBeenLastCalledWith("", MODES_CLEARED);
  });

  it("works before the creature is awake, and survives a reload", () => {
    const store = memory();
    const before = new OperatorStanding(store, () => at(21));
    before.setSpookiness(3);
    before.toggleMode("candyLow");
    const reloaded = new OperatorStanding(store, () => at(22));
    expect(reloaded.spookyChoice).toBe(3);
    expect(reloaded.active).toEqual(["candyLow"]);
    expect(store.data.has(MODES_KEY)).toBe(true);
    const e = engine();
    reloaded.attach(e);
    expect(e.setStanding).toHaveBeenCalledWith(standingInstructions(["candyLow"], 3));
  });

  it("holds gentle under Toddler mode and comes back when it's off", () => {
    const standing = new OperatorStanding(memory(), () => at(21));
    const e = engine();
    standing.attach(e);
    standing.setSpookiness(3);
    const levels: number[] = [];
    standing.onSpookiness((level) => levels.push(level));
    standing.toggleMode("toddler");
    expect(standing.spookiness).toBe(0);
    expect(e.setStanding.mock.lastCall![0]).toContain("Very little kids are here");
    expect(e.setStanding.mock.lastCall![0]).not.toContain("for teens");
    // Turning the dial while Toddler mode is on changes nothing yet.
    e.setStanding.mockClear();
    standing.setSpookiness(2);
    expect(e.setStanding).not.toHaveBeenCalled();
    standing.toggleMode("toddler");
    expect(standing.spookiness).toBe(2);
    expect(levels).toEqual([0, 2]);
  });

  it("moves with the clock on auto, sending only real changes", () => {
    let now = at(18, 30);
    const standing = new OperatorStanding(memory(), () => now);
    standing.setSpookiness("auto");
    const e = engine();
    standing.attach(e);
    expect(standing.spookiness).toBe(0);
    expect(standing.tick()).toBe(false);
    expect(e.setStanding).toHaveBeenCalledTimes(1);
    now = at(19, 5);
    expect(standing.tick()).toBe(true);
    expect(e.setStanding).toHaveBeenLastCalledWith("", MODES_CLEARED);
    now = at(20, 1);
    expect(standing.tick()).toBe(true);
    expect(standing.spookiness).toBe(2);
    expect(e.setStanding).toHaveBeenLastCalledWith(standingInstructions([], 2), standingUpdate([], 2));
    expect(standing.tick()).toBe(false);
    expect(e.setStanding).toHaveBeenCalledTimes(3);
  });
});
