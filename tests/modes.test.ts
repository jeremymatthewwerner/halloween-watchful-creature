import { describe, expect, it } from "vitest";
import { MODES, MODES_CLEARED, MODES_KEY, eveningOf, loadModes, modeInstructions, modeUpdate, saveModes, toggleMode } from "../web/modes.ts";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe("operator quick modes", () => {
  it("has the six quick buttons", () => {
    expect(MODES.map((m) => m.label)).toEqual([
      "🍬 Candy's low",
      "🚫 Candy's out",
      "🔔 Ring the doorbell",
      "🧸 Toddler mode",
      "⏳ Back in 5",
      "🌙 Last call",
    ]);
  });

  it("uses kid-first wording: simple, gentle, no French and no chef talk", () => {
    const all = MODES.map((m) => m.rule).join(" ") + modeInstructions(MODES.map((m) => m.id)) + MODES_CLEARED;
    expect(all).not.toMatch(/bonsoir|magnifique|mon ami|ooh la la|chef|kiss|cuisine|palate|recipe|scary voice/i);
    for (const m of MODES) expect(m.rule.length).toBeLessThan(260);
    expect(MODES.find((m) => m.id === "toddler")!.rule).toMatch(/Nothing spooky/);
    expect(MODES.find((m) => m.id === "candyOut")!.rule).toMatch(/sorry.*compliment/s);
  });

  it("turns modes on and off, keeping candy low and candy out apart", () => {
    let active = toggleMode([], "toddler");
    active = toggleMode(active, "candyLow");
    expect(active).toEqual(["candyLow", "toddler"]);
    active = toggleMode(active, "candyOut");
    expect(active).toEqual(["candyOut", "toddler"]);
    expect(toggleMode(active, "toddler")).toEqual(["candyOut"]);
    expect(toggleMode(active, "toddler", true)).toEqual(["candyOut", "toddler"]);
  });

  it("sends visitors to the doorbell instead of a candy bowl, never together with the bowl modes", () => {
    const rule = MODES.find((m) => m.id === "doorbell")!.rule;
    expect(rule).toMatch(/ring the doorbell/);
    expect(rule).toMatch(/Never tell anyone to take candy from a bowl/);
    expect(toggleMode(["candyLow", "toddler"], "doorbell")).toEqual(["doorbell", "toddler"]);
    expect(toggleMode(["doorbell"], "candyOut")).toEqual(["candyOut"]);
    expect(toggleMode(["doorbell"], "candyLow")).toEqual(["candyLow"]);
    expect(modeInstructions(["doorbell"])).toContain("ring the doorbell");
  });

  it("builds one set of standing instructions that replaces the earlier ones", () => {
    expect(modeInstructions([])).toBe("");
    const text = modeInstructions(["lastCall", "candyOut"]);
    expect(text).toMatch(/^\[OPERATOR\]/);
    expect(text).toContain("replace any earlier standing instructions");
    expect(text).toContain("Don't mention");
    expect(text.indexOf("candy is all gone")).toBeLessThan(text.indexOf("almost over"));
    expect(text).not.toContain("almost gone");
    expect(modeUpdate([])).toBe(MODES_CLEARED);
    expect(modeUpdate(["backIn5"])).toContain("back in about five minutes");
  });

  it("remembers the modes for the evening, past midnight but not into the next day", () => {
    const store = memory();
    const tenPm = new Date(2026, 9, 31, 22, 0);
    saveModes(store, ["toddler", "candyLow"], tenPm);
    expect(JSON.parse(store.data.get(MODES_KEY)!)).toEqual({ evening: "2026-10-31", on: ["candyLow", "toddler"] });
    expect(loadModes(store, new Date(2026, 10, 1, 1, 30))).toEqual(["candyLow", "toddler"]);
    expect(loadModes(store, new Date(2026, 10, 1, 17, 0))).toEqual([]);
    expect(eveningOf(new Date(2026, 10, 1, 5, 59))).toBe("2026-10-31");
  });

  it("ignores broken or unknown saved state", () => {
    const store = memory();
    store.setItem(MODES_KEY, "{nope");
    expect(loadModes(store)).toEqual([]);
    store.setItem(MODES_KEY, JSON.stringify({ evening: eveningOf(new Date()), on: ["toddler", "dance"] }));
    expect(loadModes(store)).toEqual(["toddler"]);
    expect(loadModes(null)).toEqual([]);
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadModes(throwing)).toEqual([]);
    expect(() => saveModes(throwing, ["toddler"])).not.toThrow();
  });
});
