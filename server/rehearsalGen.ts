/**
 * Rehearsal mode's "Generate visitors": made-up groups of trick-or-treaters drawn by OpenAI's
 * image model, cached on disk so each picture is paid for once and reused.
 *
 * Every prompt asks for a clearly fictional, stylized picture (animated-film render, storybook
 * illustration or clay figures) of anonymous cartoon people: no photos, no real or recognizable
 * persons, no famous characters, nothing scary, no text. The scenario (group size, costumes,
 * lighting) is stored next to the image, so rehearsal can simulate the matching person count.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenerateVisitorsRequest, GeneratedVisitor, VisitorScenario } from "../shared/types.ts";
import type { ImageUsage } from "./openai.ts";

export interface Costume {
  id: string;
  /** Short name shown in the panel. */
  label: string;
  /** How the image prompt describes this person. */
  prompt: string;
}

/** Original, generic costumes only: no trademarked characters. */
export const COSTUMES: readonly Costume[] = [
  { id: "dinosaur", label: "dinosaur", prompt: "a child in a green dinosaur costume with a hood full of soft felt teeth and a spiky tail" },
  { id: "witch", label: "witch with a purple hat", prompt: "a child dressed as a witch with a tall purple pointy hat, a black cape and a little broom" },
  { id: "astronaut", label: "astronaut", prompt: "a child in a puffy white astronaut suit with mission patches and a helmet tucked under one arm" },
  { id: "ghost", label: "ghost sheet", prompt: "a child wearing a white bedsheet ghost costume with two round eye holes, holding a candy bucket" },
  { id: "superhero", label: "superhero", prompt: "a child dressed as an invented superhero (not any known character) with a red cape, a blue mask and a lightning-bolt emblem" },
  { id: "princess", label: "princess", prompt: "a child dressed as a princess in a sparkly pink gown with a plastic tiara and a star wand" },
  { id: "pirate", label: "pirate", prompt: "a child dressed as a pirate with a tricorn hat, an eye patch, a striped shirt and a foam sword" },
  { id: "skeleton", label: "skeleton", prompt: "a child in a black skeleton onesie with glow-in-the-dark bones" },
  { id: "bumblebee", label: "bumblebee", prompt: "a small child in a fuzzy yellow-and-black striped bumblebee costume with little wings and antennae" },
  { id: "ninja", label: "ninja", prompt: "a child dressed as a ninja in black with a red sash and a cloth mask showing only the eyes" },
  { id: "unicorn", label: "unicorn", prompt: "a child in a white unicorn costume with a rainbow mane and a golden horn on the hood" },
  { id: "firefighter", label: "firefighter", prompt: "a child dressed as a firefighter with a red helmet and a yellow coat with reflective stripes" },
  { id: "robot", label: "cardboard robot", prompt: "a child in a homemade cardboard-box robot costume with bottle-cap buttons and foil-wrapped arms" },
  { id: "vampire", label: "friendly vampire", prompt: "a child dressed as a friendly cartoon vampire with a high-collared black-and-red cape and a big smile" },
  { id: "pumpkin", label: "pumpkin", prompt: "a toddler in a round orange pumpkin costume with a green stem hat" },
  { id: "mermaid", label: "mermaid", prompt: "a child dressed as a mermaid with a shimmering teal tail skirt and a seashell necklace" },
  { id: "wizard", label: "wizard", prompt: "a child dressed as a wizard in a starry blue robe, a matching pointed hat and a long cotton-wool beard" },
  { id: "black-cat", label: "black cat", prompt: "a child dressed as a black cat with ear headband, drawn-on whiskers and a long tail" },
  { id: "knight", label: "knight", prompt: "a child dressed as a knight with silver foam armor, a shield with a dragon crest and a helmet" },
  { id: "butterfly", label: "butterfly", prompt: "a child with big orange-and-black butterfly wings and sparkly antennae" },
  { id: "chef", label: "chef", prompt: "a child dressed as a chef with a tall white hat, an apron and a wooden spoon" },
  { id: "mummy", label: "mummy", prompt: "a child dressed as a cute, silly mummy wrapped in loose white bandages, waving" },
  { id: "parent", label: "parent, no costume", prompt: "a grown-up in everyday clothes (a jacket and jeans, no costume) holding a flashlight and a candy bag" },
  { id: "teen-lazy", label: "teen in a lazy costume", prompt: "a teenager in a hoodie and jeans with only a cat-ear headband as a costume, holding a pillowcase for candy" },
];

const COSTUME_BY_ID = new Map(COSTUMES.map((c) => [c.id, c]));

export const LIGHTING: Record<VisitorScenario["lighting"], string> = {
  bright: "lit clearly by a bright warm porch light overhead, so every costume is easy to see",
  dim: "in dim light from a single weak porch bulb, a little hard to see, with soft shadows",
  backlit: "backlit by an open doorway glowing behind them, so the costumes are partly in silhouette",
  lantern: "lit mostly by the orange glow of jack-o'-lanterns on the steps, with a dark blue night sky",
};

export const STYLES: Record<VisitorScenario["style"], string> = {
  animated: "a stylized 3D animated-film render with soft rounded cartoon characters",
  storybook: "a colorful hand-painted children's-book illustration",
  clay: "a cheerful claymation-style render of little clay figures",
};

export const MAX_GROUP = 4;
export const MAX_PER_REQUEST = 6;

/** USD per 1M tokens for gpt-image-2.5 (flare and sunburst), from OpenAI's pricing page (Oct 2026). */
export const IMAGE_TOKEN_PRICES = { textInput: 5, imageInput: 8, output: 30 };

export type Rng = () => number;

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length) % items.length]!;

/** Picks `n` different items. */
function pickDistinct<T>(rng: Rng, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length) % pool.length, 1)[0]!);
  return out;
}

/** Checks a generate request; returns an error message, or null if it's fine. */
export function checkRequest(req: GenerateVisitorsRequest): string | null {
  if (req.count !== undefined && (!Number.isInteger(req.count) || req.count < 1 || req.count > MAX_PER_REQUEST)) {
    return `count must be a whole number from 1 to ${MAX_PER_REQUEST}`;
  }
  if (req.groupSize !== undefined && (!Number.isInteger(req.groupSize) || req.groupSize < 1 || req.groupSize > MAX_GROUP)) {
    return `groupSize must be a whole number from 1 to ${MAX_GROUP}`;
  }
  if (req.costumes !== undefined) {
    if (!Array.isArray(req.costumes) || req.costumes.length < 1 || req.costumes.length > MAX_GROUP) return `costumes must list 1 to ${MAX_GROUP} costume ids`;
    const unknown = req.costumes.find((c) => typeof c !== "string" || !COSTUME_BY_ID.has(c));
    if (unknown !== undefined) return `unknown costume "${String(unknown)}"`;
    if (req.groupSize !== undefined && req.groupSize !== req.costumes.length) return "groupSize must match the number of costumes";
  }
  if (req.lighting !== undefined && !(req.lighting in LIGHTING)) return `lighting must be one of ${Object.keys(LIGHTING).join(", ")}`;
  return null;
}

/**
 * A random scenario: 1–4 people (mostly small groups, like real trick-or-treaters), distinct
 * costumes, and varied lighting and art style. Anything in `wanted` is used as given.
 */
export function pickScenario(rng: Rng = Math.random, wanted: Omit<GenerateVisitorsRequest, "count"> = {}): VisitorScenario {
  const groupSize = wanted.costumes?.length ?? wanted.groupSize ?? pick(rng, [1, 1, 2, 2, 2, 3, 3, 4]);
  let costumes = wanted.costumes ? [...wanted.costumes] : pickDistinct(rng, COSTUMES, groupSize).map((c) => c.id);
  // A lone grown-up without a costume is a useful test ("no costume visible"), but keep it rarer.
  if (!wanted.costumes && costumes.includes("parent") && groupSize === 1 && rng() < 0.5) {
    costumes = [pick(rng, COSTUMES.filter((c) => c.id !== "parent")).id];
  }
  const lighting = wanted.lighting ?? pick(rng, Object.keys(LIGHTING) as VisitorScenario["lighting"][]);
  const style = pick(rng, Object.keys(STYLES) as VisitorScenario["style"][]);
  return { groupSize, costumes, lighting, style };
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const costumeLabels = (s: VisitorScenario): string[] => s.costumes.map((id) => COSTUME_BY_ID.get(id)?.label ?? id);

/** The image prompt for a scenario. */
export function buildPrompt(s: VisitorScenario): string {
  const people = s.costumes.map((id, i) => `${i + 1}. ${COSTUME_BY_ID.get(id)?.prompt ?? id}`).join("\n");
  const who = s.groupSize === 1 ? "one trick-or-treater" : `a group of exactly ${s.groupSize} trick-or-treaters`;
  return [
    `${capitalize(STYLES[s.style])} of ${who} standing on a front porch on Halloween night, ${LIGHTING[s.lighting]}.`,
    `The view is from a friendly talking jack-o'-lantern decoration at about waist height, looking straight at them from a couple of steps away, so they fill most of a wide landscape frame.`,
    `Exactly ${s.groupSize} ${s.groupSize === 1 ? "person is" : "people are"} visible, ${s.groupSize === 1 ? "fully in frame" : "side by side, each fully in frame and not hidden behind another"}, with nobody else in the picture:`,
    people,
    `Clearly a stylized illustration, not a photograph: simple, generic cartoon faces that don't resemble any real person, and no famous or trademarked characters.`,
    `Warm, cozy and cheerful, nothing scary or gory, suitable for young children. No text, letters, numbers, logos or watermarks anywhere in the image.`,
  ].join("\n");
}

/** Dollars for one image from the API's reported usage. */
export function usageCost(u: ImageUsage): number {
  const imageInput = Math.max(0, u.inputTokens - u.textInputTokens);
  return (u.textInputTokens * IMAGE_TOKEN_PRICES.textInput + imageInput * IMAGE_TOKEN_PRICES.imageInput + u.outputTokens * IMAGE_TOKEN_PRICES.output) / 1e6;
}

export const VISITOR_ID = /^[a-z0-9]+-[a-f0-9]{6}$/;

/**
 * Generated images on disk: `<id>.jpg` plus `<id>.json` (the GeneratedVisitor metadata).
 * The JSON is written last, so a half-written pair never shows up in the list.
 */
export class VisitorCache {
  constructor(readonly dir: string) {}

  async list(): Promise<GeneratedVisitor[]> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const names = new Set(files);
    const items: GeneratedVisitor[] = [];
    for (const file of files) {
      const id = file.slice(0, -".json".length);
      if (!file.endsWith(".json") || !VISITOR_ID.test(id) || !names.has(`${id}.jpg`)) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.dir, file), "utf8")) as GeneratedVisitor;
        if (meta.id === id && Number.isInteger(meta.groupSize)) items.push(meta);
      } catch {
        // A broken metadata file: skip it.
      }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async image(id: string) {
    if (!VISITOR_ID.test(id)) return null;
    return readFile(join(this.dir, `${id}.jpg`)).catch(() => null);
  }

  async save(image: Buffer, meta: Omit<GeneratedVisitor, "id">, now = new Date()): Promise<GeneratedVisitor> {
    await mkdir(this.dir, { recursive: true });
    const id = `${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
    const item: GeneratedVisitor = { id, ...meta };
    await writeFile(join(this.dir, `${id}.jpg`), image);
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(item, null, 2));
    return item;
  }

  /** Deletes one image and its metadata; false if there was no such image. */
  async remove(id: string): Promise<boolean> {
    if (!VISITOR_ID.test(id) || !(await this.image(id))) return false;
    await rm(join(this.dir, `${id}.json`), { force: true });
    await rm(join(this.dir, `${id}.jpg`), { force: true });
    return true;
  }
}

/** An error's message, plus the API's own explanation (e.g. a moderation refusal) when there is one. */
function errorText(err: unknown): string {
  const message = (err as Error).message;
  const body = (err as { body?: unknown }).body;
  if (typeof body !== "string" || !body) return message;
  try {
    const detail = (JSON.parse(body) as { error?: { message?: string; code?: string } }).error;
    const why = detail?.message ?? detail?.code;
    return why ? `${message} (${why.slice(0, 300)})` : message;
  } catch {
    return message;
  }
}

export interface GenerateDeps {
  cache: VisitorCache;
  /** Makes one image (the OpenAI call; mocked in tests). */
  generate(prompt: string): Promise<{ image: Buffer; usage?: ImageUsage }>;
  model: string;
  quality: string;
  size: string;
  /** Used when the API reports no usage. */
  estimateUsd: number;
  rng?: Rng;
  log?(text: string): void;
  now?(): Date;
}

/**
 * Generates `count` images one after another, each from its own scenario, and caches them.
 * A failed image (say, a refused prompt) is reported in `errors` and the rest carry on.
 */
export async function generateVisitors(deps: GenerateDeps, req: GenerateVisitorsRequest): Promise<{ items: GeneratedVisitor[]; errors: string[] }> {
  const items: GeneratedVisitor[] = [];
  const errors: string[] = [];
  const { count = 1, ...wanted } = req;
  for (let i = 0; i < count; i++) {
    const scenario = pickScenario(deps.rng, wanted);
    const labels = costumeLabels(scenario);
    try {
      const { image, usage } = await deps.generate(buildPrompt(scenario));
      const costUsd = usage ? usageCost(usage) : deps.estimateUsd;
      const now = deps.now?.() ?? new Date();
      const item = await deps.cache.save(
        image,
        { ...scenario, createdAt: now.toISOString(), costumeLabels: labels, model: deps.model, quality: deps.quality, size: deps.size, costUsd, costEstimated: !usage },
        now,
      );
      items.push(item);
      deps.log?.(
        `[rehearsal] generated ${item.id}: ${scenario.groupSize} visitor${scenario.groupSize > 1 ? "s" : ""} (${labels.join(", ")}), ${scenario.lighting} light, ` +
          `${usage ? "" : "about "}$${costUsd.toFixed(4)}`,
      );
    } catch (err) {
      const problem = `${labels.join(", ")}: ${errorText(err)}`;
      deps.log?.(`[rehearsal] couldn't generate ${problem}`);
      errors.push(problem);
    }
  }
  return { items, errors };
}
