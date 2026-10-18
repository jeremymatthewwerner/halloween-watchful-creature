import { describe, expect, it } from "vitest";
import { buildInstructions, listCharacterIds, loadCharacter, parseCharacterFile } from "../server/characters.ts";
import { extractOutputText } from "../server/openai.ts";
import { Transcript } from "../web/transcript.ts";
import { isKnownVoice } from "../shared/voices.ts";

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

  it("includes the trick-or-treat mini-games only for characters that opt in", () => {
    const pumpkin = loadCharacter("pumpkin");
    expect(pumpkin.games).toBe(true);
    const live = buildInstructions(pumpkin, "live");
    expect(live).toContain("# Trick-or-treat mini-games");
    expect(live).toContain("Pick 'trick' and you get a riddle!");
    expect(live).toContain("At most one game per visit");
    expect(live).toContain("Never block the candy");
    // Games sit after the persona and before the senses.
    expect(live.indexOf("Jacques O'Lantern")).toBeLessThan(live.indexOf("# Trick-or-treat mini-games"));
    expect(live.indexOf("# Trick-or-treat mini-games")).toBeLessThan(live.indexOf("# How your senses work"));

    const raven = loadCharacter("raven");
    expect(raven.games).toBe(false);
    expect(buildInstructions(raven, "live")).not.toContain("mini-games");

    const head = "---\nname: X\nvoice: v\neyes_sleeping: '#000000'\neyes_idle: '#000000'\neyes_listening: '#000000'\neyes_thinking: '#000000'\neyes_speaking: '#000000'\n";
    expect(parseCharacterFile("x", `${head}games: on\n---\nbody`).games).toBe(true);
    expect(parseCharacterFile("x", `${head}---\nbody`).games).toBe(false);
    expect(() => parseCharacterFile("x", `${head}games: sometimes\n---\nbody`)).toThrow(/games/);
  });

  it("keeps the no-costume and never-truly-scary rules kid-friendly and consistent for every character", () => {
    for (const id of listCharacterIds()) {
      const live = buildInstructions(loadCharacter(id), "live");
      // base.md and pumpkin.md used to disagree about this phrase; no character is told it any more.
      expect(live, id).not.toMatch(/civilian/i);
      expect(live, id).toContain("**No costume?** That's okay! Keep it warm and simple");
      expect(live, id).toContain("Never make anyone feel bad");
      // The spookiness dial works inside the hard limits, never past them.
      expect(live, id).toContain("No gore, death, threats, cruelty, meanness or jump-scares, ever.");
      expect(live, id).toContain('a "Spookiness tonight" standing instruction: follow it, but no setting ever lifts these limits');
      expect(live, id).toContain("if a little kid seems unsure or nervous, or anyone seems scared or says so");
    }
  });

  it("validates frontmatter", () => {
    expect(() => parseCharacterFile("x", "no frontmatter")).toThrow(/frontmatter/);
    expect(() => parseCharacterFile("x", "---\nname: X\n---\nbody")).toThrow(/is missing/);
  });

  it("gives every character voices from the allowlists", () => {
    for (const id of listCharacterIds()) {
      const c = loadCharacter(id);
      expect(isKnownVoice("live", c.voice), `${id} voice ${c.voice}`).toBe(true);
      expect(isKnownVoice("realtime", c.realtimeVoice), `${id} realtime_voice ${c.realtimeVoice}`).toBe(true);
    }
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
