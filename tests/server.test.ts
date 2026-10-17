import { describe, expect, it } from "vitest";
import { buildInstructions, listCharacterIds, loadCharacter, parseCharacterFile } from "../server/characters.ts";
import { extractOutputText } from "../server/openai.ts";
import { Transcript } from "../web/transcript.ts";

describe("characters", () => {
  it("loads every character file", () => {
    const ids = listCharacterIds();
    expect(ids).toEqual(expect.arrayContaining(["pumpkin", "reginald", "raven"]));
    for (const id of ids) {
      const c = loadCharacter(id);
      expect(c.name).toBeTruthy();
      expect(c.voice).toBeTruthy();
      expect(c.eyes.speaking).toHaveLength(3);
      expect(c.persona.length).toBeGreaterThan(100);
    }
  });

  it("builds instructions with the shared rules, persona and engine-specific senses", () => {
    const c = loadCharacter("pumpkin");
    const live = buildInstructions(c, "live");
    expect(live).toContain("Compliment costumes only");
    expect(live).toContain("Jacques O'Lantern");
    expect(live).toContain("[CAMERA]");
    expect(buildInstructions(c, "realtime")).toContain('"look" tool');
  });

  it("validates frontmatter", () => {
    expect(() => parseCharacterFile("x", "no frontmatter")).toThrow(/frontmatter/);
    expect(() => parseCharacterFile("x", "---\nname: X\n---\nbody")).toThrow(/is missing/);
  });

  it("rejects path traversal in character ids", () => {
    expect(() => loadCharacter("../base")).toThrow();
  });
});

describe("extractOutputText", () => {
  it("prefers output_text, else joins message parts", () => {
    expect(extractOutputText({ output_text: " hi " })).toBe("hi");
    expect(
      extractOutputText({
        output: [
          { type: "reasoning" },
          { type: "message", content: [{ type: "output_text", text: "A witch" }, { type: "output_text", text: "with a broom" }] },
        ],
      }),
    ).toBe("A witch\nwith a broom");
  });
});

describe("Transcript", () => {
  it("groups fragments per speaker and formats recent history", () => {
    const t = new Transcript(1000);
    t.add("visitor", "What do", 0);
    t.add("creature", "Ooh", 100);
    t.add("visitor", " you think?", 200);
    t.add("system", "note", 300);
    t.add("creature", "Five pumpkins!", 5000);
    expect(t.lines.map((l) => l.text)).toEqual(["What do you think?", "Ooh", "note", "Five pumpkins!"]);
    expect(t.recent()).toBe("Visitor: What do you think?\nCreature: Ooh\nCreature: Five pumpkins!");
  });
});
