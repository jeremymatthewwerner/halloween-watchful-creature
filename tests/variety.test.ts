import { describe, expect, it } from "vitest";
import {
  GROUP_FINISHES,
  GROUP_OPENINGS,
  OPENINGS,
  SPOOKY_GROUP_FINISHES,
  SPOOKY_OPENINGS,
  SPOOKY_VERDICTS,
  VERDICTS,
  Variety,
} from "../web/engines/variety.ts";

describe("Variety", () => {
  it("never gives the same twist twice in a row, even if the dice say so", () => {
    const v = new Variety(() => 0.1); // always rolls the same index
    const first = v.opening();
    const second = v.opening();
    expect(second).not.toBe(first);
    expect(v.opening()).toBe(first);
  });

  it("adds the spookiness dial's twists only at their level", () => {
    let level: 0 | 1 | 2 | 3 = 1;
    const v = new Variety(Math.random, () => level);
    const sample = () => {
      const seen = new Set<string>();
      for (let i = 0; i < 400; i++) seen.add(v.greeting());
      return [...seen].join("\n");
    };
    const all = (lists: Record<number, readonly string[]>) => Object.values(lists).flat();
    const playful = sample();
    for (const twist of [...all(SPOOKY_OPENINGS), ...all(SPOOKY_VERDICTS)]) expect(playful).not.toContain(twist);
    level = 3;
    const scary = sample();
    for (const twist of [...SPOOKY_OPENINGS[3], ...SPOOKY_VERDICTS[3]]) expect(scary).toContain(twist);
    expect(scary).not.toContain(SPOOKY_OPENINGS[0][0]);
    level = 0;
    const gentle = sample();
    expect(gentle).toContain(SPOOKY_OPENINGS[0][0]);
    expect(gentle).not.toMatch(/eerie|creepy|ghost-story/);
  });

  it("covers the whole list over many greetings", () => {
    const v = new Variety();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(v.greeting());
    for (const o of OPENINGS) expect([...seen].some((g) => g.includes(o))).toBe(true);
    for (const f of VERDICTS) expect([...seen].some((g) => g.includes(f))).toBe(true);
  });

  it("has group twists for big groups, covering the list, spooky ones only at their level, never twice in a row", () => {
    let level: 0 | 1 | 2 | 3 = 1;
    const v = new Variety(Math.random, () => level);
    const seen = new Set<string>();
    let last = "";
    for (let i = 0; i < 100; i++) {
      const finish = v.groupFinish();
      expect(finish).not.toBe(last);
      last = finish;
    }
    for (let i = 0; i < 500; i++) seen.add(v.groupGreeting());
    const all = [...seen].join("\n");
    for (const twist of [...GROUP_OPENINGS, ...GROUP_FINISHES]) expect(all).toContain(twist);
    for (const twist of Object.values(SPOOKY_GROUP_FINISHES).flat()) expect(all).not.toContain(twist);
    // Group moments are for everyone at once: no per-costume verdicts.
    for (const twist of VERDICTS) expect(all).not.toContain(twist);
    level = 3;
    const scary = new Set<string>();
    for (let i = 0; i < 200; i++) scary.add(v.groupGreeting());
    expect([...scary].join("\n")).toContain(SPOOKY_GROUP_FINISHES[3][0]);
  });
});
