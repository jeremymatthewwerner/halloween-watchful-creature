import { describe, expect, it } from "vitest";
import {
  EveningMemory,
  MAX_LINES,
  MAX_LINE_CHARS,
  MAX_MEMORY_CHARS,
  STORAGE_KEY,
  costumeKinds,
  eveningOf,
  type StorageLike,
} from "../web/evening.ts";

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const halloween = (time: string) => new Date(`2026-10-31T${time}`);

describe("eveningOf", () => {
  it("runs noon to noon, so a night past midnight is one evening", () => {
    expect(eveningOf(halloween("18:00:00"))).toBe("2026-10-31");
    expect(eveningOf(new Date("2026-11-01T01:30:00"))).toBe("2026-10-31");
    expect(eveningOf(new Date("2026-11-01T13:00:00"))).toBe("2026-11-01");
  });
});

describe("costumeKinds", () => {
  it("picks out costume kinds, including plurals and well-known heroes", () => {
    expect(costumeKinds("Two visitors: a witch with a broom and a green T-Rex costume.")).toEqual(["witch", "dinosaur"]);
    expect(costumeKinds("Three witches and a Spider-Man.")).toEqual(["superhero", "witch"]);
    expect(costumeKinds("One visitor in a plain blue T-shirt holding a pumpkin bucket.")).toEqual([]);
  });
});

describe("EveningMemory", () => {
  it("keeps the last lines, shortened, without repeats, and survives a reload", () => {
    const storage = new FakeStorage();
    let now = halloween("18:00:00");
    const m = new EveningMemory(storage, () => now);
    for (let i = 1; i <= MAX_LINES + 5; i++) m.recordLine(`Line number ${i}, what a costume!`);
    m.recordLine("Line number 25, what a costume!"); // said again: moves to the end, not duplicated
    m.recordLine("ok"); // too short to be worth remembering
    m.recordLine(`Wow! ${"so very ".repeat(40)}spooky. Five stars!`);
    const said = m.current.said;
    expect(said).toHaveLength(MAX_LINES);
    expect(said[0]).toBe("Line number 7, what a costume!");
    expect(said.filter((l) => l.startsWith("Line number 25"))).toHaveLength(1);
    const long = said.at(-1)!;
    expect(long.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(long).toMatch(/^Wow! so very .* … .*spooky\. Five stars!$/);

    now = halloween("20:00:00");
    const reloaded = new EveningMemory(storage, () => now);
    expect(reloaded.current.said).toEqual(said);
  });

  it("starts fresh the next evening, even mid-run", () => {
    const storage = new FakeStorage();
    let now = halloween("21:00:00");
    const m = new EveningMemory(storage, () => now);
    m.recordLine("A spooky hello to you!");
    m.recordGroup("A witch.");
    now = new Date("2026-11-01T18:00:00");
    expect(m.current).toMatchObject({ evening: "2026-11-01", said: [], groups: 0, costumes: {} });
    expect(m.memoryContext()).toBeNull();
    expect(new EveningMemory(storage, () => now).current.groups).toBe(0);
  });

  it("ignores unreadable saved data and a missing or failing storage", () => {
    const storage = new FakeStorage();
    storage.setItem(STORAGE_KEY, "{not json");
    expect(new EveningMemory(storage).current.said).toEqual([]);
    const failing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    const m = new EveningMemory(failing);
    m.recordLine("Still works without storage!");
    expect(m.current.said).toEqual(["Still works without storage!"]);
    expect(new EveningMemory(null).recordGroup("A ghost.")).toBe(1);
  });

  it("builds a session memory of what was said, capped for one context append", () => {
    const m = new EveningMemory(new FakeStorage(), () => halloween("19:00:00"));
    expect(m.memoryContext()).toBeNull();
    for (let i = 1; i <= MAX_LINES; i++) m.recordLine(`Verdict ${i}: ${"a truly magnificent costume ".repeat(5)}!`);
    m.recordGroup("Two witches.");
    const memory = m.memoryContext()!;
    expect(memory).toMatch(/^\[MEMORY\] Background only/);
    expect(memory).toContain("don't reuse these lines, jokes or verdicts");
    expect(memory).toContain("you've greeted 1 visitor group; costumes seen: witch 1.");
    expect(memory.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
    // Oldest lines go first when it's too long; the newest are always kept.
    expect(memory).toContain(`Verdict ${MAX_LINES}:`);
    expect(memory).not.toContain("Verdict 1:");
  });

  it("counts groups and costumes, without double-counting a group that grew", () => {
    const m = new EveningMemory(new FakeStorage(), () => halloween("19:00:00"));
    expect(m.tonightContext(null)).toBeNull();
    expect(m.recordGroup("One visitor in a green dinosaur costume.")).toBe(1);
    expect(m.recordGroup("A witch and a dinosaur.")).toBe(2);
    // Grew: the dinosaur was already counted; the ghost is new.
    expect(m.recordGroup("A witch, a dinosaur and a ghost.", "A witch and a dinosaur.")).toBe(3);
    expect(m.recordGroup(null)).toBe(4); // no clear look: counted, no costumes
    expect(m.current.costumes).toEqual({ dinosaur: 2, witch: 1, ghost: 1 });
  });

  it("offers the group number, costume streaks and milestones as optional fun facts", () => {
    const m = new EveningMemory(new FakeStorage(), () => halloween("19:00:00"));
    m.recordGroup("A dinosaur.");
    m.recordGroup("A witch.");
    m.recordGroup("Another dinosaur, with a witch hat.");
    const facts = m.tonightContext("Another dinosaur, with a witch hat.")!;
    expect(facts).toMatch(/^ \[TONIGHT\] Optional fun facts, only if they fit naturally/);
    expect(facts).toContain("group number 3 you've greeted tonight");
    expect(facts).toContain("the second witch tonight and the second dinosaur tonight");
    expect(facts).toContain("costumes so far tonight (groups): dinosaur 2, witch 2");
    expect(facts).not.toContain("milestone");
    for (let i = 4; i <= 25; i++) m.recordGroup("A pirate.");
    const milestone = m.tonightContext("A pirate.")!;
    expect(milestone).toContain('Group 25 is a milestone: you could celebrate it ("visitor number 25!")');
    expect(milestone).toContain("the 22nd pirate tonight");
  });
});
