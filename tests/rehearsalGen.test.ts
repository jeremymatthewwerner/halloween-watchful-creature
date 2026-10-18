import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COSTUMES,
  LIGHTING,
  MAX_PER_REQUEST,
  VisitorCache,
  buildPrompt,
  checkRequest,
  costumeLabels,
  generateVisitors,
  pickScenario,
  usageCost,
  type GenerateDeps,
} from "../server/rehearsalGen.ts";
import { OpenAIError } from "../server/openai.ts";

/** A small deterministic random number generator (mulberry32). */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe("visitor scenarios", () => {
  it("picks 1–4 people with distinct, known costumes, and varies size, costumes and lighting", () => {
    const rng = seeded(42);
    const sizes = new Set<number>();
    const lights = new Set<string>();
    const costumes = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const s = pickScenario(rng);
      expect(s.groupSize).toBeGreaterThanOrEqual(1);
      expect(s.groupSize).toBeLessThanOrEqual(4);
      expect(s.costumes).toHaveLength(s.groupSize);
      expect(new Set(s.costumes).size).toBe(s.groupSize);
      for (const c of s.costumes) expect(COSTUMES.some((k) => k.id === c)).toBe(true);
      sizes.add(s.groupSize);
      lights.add(s.lighting);
      s.costumes.forEach((c) => costumes.add(c));
    }
    expect([...sizes].sort()).toEqual([1, 2, 3, 4]);
    expect(lights).toEqual(new Set(Object.keys(LIGHTING)));
    expect(costumes.size).toBeGreaterThan(COSTUMES.length - 3);
  });

  it("has the costumes the owner asked for", () => {
    const ids = COSTUMES.map((c) => c.id);
    for (const id of ["dinosaur", "witch", "astronaut", "ghost", "superhero", "princess", "pirate", "skeleton", "bumblebee", "ninja", "unicorn", "firefighter", "parent", "teen-lazy"]) {
      expect(ids).toContain(id);
    }
    expect(COSTUMES.find((c) => c.id === "witch")!.prompt).toMatch(/purple/);
  });

  it("uses a requested group size, costumes or lighting as given", () => {
    const rng = seeded(7);
    for (let i = 0; i < 20; i++) expect(pickScenario(rng, { groupSize: 3 }).groupSize).toBe(3);
    const s = pickScenario(rng, { costumes: ["pirate", "ghost"], lighting: "backlit" });
    expect(s).toMatchObject({ groupSize: 2, costumes: ["pirate", "ghost"], lighting: "backlit" });
    expect(costumeLabels(s)).toEqual(["pirate", "ghost sheet"]);
  });

  it("checks requests", () => {
    expect(checkRequest({})).toBeNull();
    expect(checkRequest({ count: MAX_PER_REQUEST, groupSize: 4, costumes: ["ninja", "unicorn", "pirate", "chef"], lighting: "dim" })).toBeNull();
    expect(checkRequest({ count: 0 })).toMatch(/count/);
    expect(checkRequest({ count: MAX_PER_REQUEST + 1 })).toMatch(/count/);
    expect(checkRequest({ count: 1.5 })).toMatch(/count/);
    expect(checkRequest({ groupSize: 5 })).toMatch(/groupSize/);
    expect(checkRequest({ costumes: ["ninja", "a famous movie star"] })).toMatch(/unknown costume/);
    expect(checkRequest({ costumes: [] })).toMatch(/costumes/);
    expect(checkRequest({ costumes: ["ninja"], groupSize: 2 })).toMatch(/match/);
    expect(checkRequest({ lighting: "strobe" as never })).toMatch(/lighting/);
  });

  it("builds a prompt for a fictional, kid-friendly, text-free illustration with the exact head count", () => {
    const prompt = buildPrompt({ groupSize: 3, costumes: ["dinosaur", "witch", "parent"], lighting: "dim", style: "clay" });
    expect(prompt).toMatch(/exactly 3 trick-or-treaters/);
    expect(prompt).toMatch(/Exactly 3 people are visible/);
    expect(prompt).toMatch(/dinosaur costume/);
    expect(prompt).toMatch(/purple pointy hat/);
    expect(prompt).toMatch(/no costume/);
    expect(prompt).toMatch(/weak porch bulb/);
    expect(prompt).toMatch(/claymation/);
    expect(prompt).toMatch(/not a photograph/);
    expect(prompt).toMatch(/don't resemble any real person/);
    expect(prompt).toMatch(/no famous or trademarked characters/);
    expect(prompt).toMatch(/nothing scary/);
    expect(prompt).toMatch(/No text/);
    expect(buildPrompt({ groupSize: 1, costumes: ["ghost"], lighting: "bright", style: "animated" })).toMatch(/one trick-or-treater[\s\S]*Exactly 1 person is visible/);
  });

  it("prices an image from its token usage", () => {
    // 300 text tokens at $5/M plus 200 output tokens at $30/M.
    expect(usageCost({ inputTokens: 300, textInputTokens: 300, outputTokens: 200 })).toBeCloseTo(0.0075, 6);
  });
});

describe("VisitorCache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rehearsal-cache-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const meta = (createdAt: string) => ({
    groupSize: 2,
    costumes: ["pirate", "ghost"],
    costumeLabels: ["pirate", "ghost sheet"],
    lighting: "bright" as const,
    style: "animated" as const,
    createdAt,
    model: "m",
    quality: "low",
    size: "1536x1024",
    costUsd: 0.01,
    costEstimated: true,
  });

  it("saves, lists (newest first), reads and deletes images with their scenario", async () => {
    const cache = new VisitorCache(join(dir, "nested")); // created on first save
    expect(await cache.list()).toEqual([]);
    const a = await cache.save(JPEG, meta("2026-10-18T10:00:00.000Z"), new Date("2026-10-18T10:00:00Z"));
    const b = await cache.save(JPEG, meta("2026-10-18T11:00:00.000Z"), new Date("2026-10-18T11:00:00Z"));
    expect(a.id).toMatch(/^[a-z0-9]+-[a-f0-9]{6}$/);
    expect((await cache.list()).map((i) => i.id)).toEqual([b.id, a.id]);
    expect((await cache.list())[0]).toMatchObject({ groupSize: 2, costumeLabels: ["pirate", "ghost sheet"] });
    expect(await cache.image(a.id)).toEqual(JPEG);

    expect(await cache.remove(a.id)).toBe(true);
    expect(await cache.remove(a.id)).toBe(false);
    expect(await cache.image(a.id)).toBeNull();
    expect((await cache.list()).map((i) => i.id)).toEqual([b.id]);
    expect((await readdir(join(dir, "nested"))).sort()).toEqual([`${b.id}.jpg`, `${b.id}.json`]);
  });

  it("refuses ids that could escape the folder, and skips broken or half-written entries", async () => {
    const cache = new VisitorCache(dir);
    await writeFile(join(dir, "secret.jpg"), "x");
    expect(await cache.image("../secret")).toBeNull();
    expect(await cache.image("secret")).toBeNull();
    expect(await cache.remove("../secret")).toBe(false);
    await writeFile(join(dir, "abc-123456.json"), "{ not json");
    await writeFile(join(dir, "abc-123456.jpg"), JPEG);
    await writeFile(join(dir, "def-abcdef.json"), JSON.stringify({ id: "def-abcdef", groupSize: 1 })); // no .jpg yet
    expect(await cache.list()).toEqual([]);
  });
});

describe("generateVisitors (OpenAI mocked)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rehearsal-gen-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deps(generate: GenerateDeps["generate"]): GenerateDeps & { logs: string[] } {
    const logs: string[] = [];
    return { cache: new VisitorCache(dir), generate, model: "gpt-image-2.5-flare", quality: "low", size: "1536x1024", estimateUsd: 0.01, rng: seeded(1), log: (t) => logs.push(t), logs };
  }

  it("generates and caches one image per scenario, priced from usage when reported", async () => {
    const generate = vi.fn(async (_prompt: string) => ({ image: JPEG, usage: { inputTokens: 300, textInputTokens: 300, outputTokens: 200 } }));
    const d = deps(generate);
    const result = await generateVisitors(d, { count: 3, groupSize: 2 });
    expect(result.errors).toEqual([]);
    expect(result.items).toHaveLength(3);
    expect(generate).toHaveBeenCalledTimes(3);
    for (const [prompt] of generate.mock.calls) expect(prompt).toMatch(/exactly 2 trick-or-treaters/);
    for (const item of result.items) {
      expect(item).toMatchObject({ groupSize: 2, model: "gpt-image-2.5-flare", quality: "low", size: "1536x1024", costEstimated: false });
      expect(item.costUsd).toBeCloseTo(0.0075, 6);
      expect(item.costumeLabels).toHaveLength(2);
    }
    expect((await d.cache.list()).map((i) => i.id).sort()).toEqual(result.items.map((i) => i.id).sort());
    expect(d.logs[0]).toMatch(/^\[rehearsal\] generated .*2 visitors .*\$0\.0075$/);
  });

  it("falls back to the estimate without usage, and keeps going after a refused image", async () => {
    let call = 0;
    const generate = vi.fn(async () => {
      if (++call === 2) throw new OpenAIError("OpenAI /images/generations failed with 400", 400, JSON.stringify({ error: { code: "moderation_blocked", message: "Your request was rejected by the safety system." } }));
      return { image: JPEG };
    });
    const d = deps(generate);
    const result = await generateVisitors(d, { count: 3 });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.costEstimated && i.costUsd === 0.01)).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/failed with 400 \(Your request was rejected by the safety system\.\)/);
    expect(d.logs.some((l) => l.includes("couldn't generate"))).toBe(true);
    expect(await d.cache.list()).toHaveLength(2);
  });
});
