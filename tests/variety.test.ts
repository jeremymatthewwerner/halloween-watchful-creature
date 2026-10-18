import { describe, expect, it } from "vitest";
import { OPENINGS, SPOOKY_OPENINGS, SPOOKY_VERDICTS, VERDICTS, Variety } from "../web/engines/variety.ts";

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
});
