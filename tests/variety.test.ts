import { describe, expect, it } from "vitest";
import { OPENINGS, VERDICTS, Variety } from "../web/engines/variety.ts";

describe("Variety", () => {
  it("never gives the same twist twice in a row, even if the dice say so", () => {
    const v = new Variety(() => 0.1); // always rolls the same index
    const first = v.opening();
    const second = v.opening();
    expect(second).not.toBe(first);
    expect(v.opening()).toBe(first);
  });

  it("covers the whole list over many greetings", () => {
    const v = new Variety();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(v.greeting());
    for (const o of OPENINGS) expect([...seen].some((g) => g.includes(o))).toBe(true);
    for (const f of VERDICTS) expect([...seen].some((g) => g.includes(f))).toBe(true);
  });
});
