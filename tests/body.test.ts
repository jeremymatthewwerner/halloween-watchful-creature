import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BodyController, pickArduinoPort, type LineSink } from "../server/body/driver.ts";
import { BODY_BAUD, encodeFlourish, encodeLevel, encodeModes, encodePalette, encodeState } from "../server/body/protocol.ts";
import type { BodyMessage, BodyState, EyePalette } from "../shared/types.ts";
import { BodyLink, deriveBodyState } from "../web/bodyLink.ts";
import {
  FLOURISH_MS,
  flourishFrame,
  EYE_TOP_PIXEL,
  GREETING_FLOURISH,
  JEWEL_PIXELS,
  IDLE_SPIN_MS,
  IDLE_SPIN_TURNS,
  idlePulse,
  JewelAnimator,
  LID_COLOR,
  PULSE_COLOR,
  PULSE_MS,
  SPARK_COLOR,
  sparkAt,
  LID_OPEN,
  LID_DOWN_MS,
  LID_SHUT_MS,
  lidCover,
  lidEdge,
  pixelMotion,
  BLINK_MS,
  blinkGap,
  DOUBLE_BLINK_GAP_MS,
  DOUBLE_BLINK_ODDS,
  REST_BLINK_GAP,
  SPEAK_BLINK_GAP,
  LivelyEyes,
  shiftHue,
  speakSpinRate,
  WHIRL_AT_LEAST_EVERY_MS,
  WHIRL_COOLDOWN_MS,
  WHIRL_MS,
  WHIRL_PEAK,
  whirlRate,
} from "../web/eyeFlourish.ts";

const eyes: EyePalette = {
  sleeping: [1, 2, 3],
  idle: [255, 100, 0],
  listening: [0, 255, 0],
  thinking: [128, 0, 255],
  speaking: [300, -5, 12.6],
};

class Recorder implements LineSink {
  name = "test";
  lines: string[] = [];
  write(line: string) {
    this.lines.push(line);
  }
}

describe("body protocol", () => {
  it("encodes commands", () => {
    expect(encodeModes(["eyes", "jaw"])).toBe("M eyes,jaw");
    expect(encodeModes([])).toBe("M none");
    expect(encodeState("speaking")).toBe("S speaking");
    expect(encodeLevel(0.5)).toBe("L 128");
    expect(encodeLevel(2)).toBe("L 255");
    expect(encodeLevel(Number.NaN)).toBe("L 0");
  });

  it("clamps palette colors to bytes", () => {
    expect(encodePalette(eyes)).toContain("P speaking 255 0 13");
    expect(encodePalette(eyes)).toHaveLength(5);
  });

  it("rejects unknown states", () => {
    expect(() => encodeState("dancing" as never)).toThrow();
  });

  it("talks at the same speed as the firmware", () => {
    const firmware = readFileSync(new URL("../firmware/creature_body/creature_body.ino", import.meta.url), "utf8");
    expect(firmware).toContain(`Serial.begin(${BODY_BAUD});`);
  });

  it("encodes eye flourishes, rejecting unknown ones", () => {
    expect(encodeFlourish("sparkle")).toBe("F sparkle");
    expect(encodeFlourish("gasp")).toBe("F gasp");
    expect(encodeFlourish("slowblink")).toBe("F slowblink");
    expect(() => encodeFlourish("wink" as never)).toThrow();
  });
});

describe("BodyController", () => {
  it("replays modes, palette and state when hardware connects", () => {
    const sink = new Recorder();
    const body = new BodyController(sink, ["eyes"]);
    body.handle({ type: "palette", eyes, eyeStyle: "flicker" });
    body.handle({ type: "state", state: "idle" });
    sink.lines = [];
    body.replay();
    expect(sink.lines[0]).toBe("M eyes");
    expect(sink.lines[1]).toBe("Y flicker");
    expect(sink.lines.at(-1)).toBe("S idle");
  });

  it("only sends state changes", () => {
    const sink = new Recorder();
    const body = new BodyController(sink, ["eyes"]);
    body.handle({ type: "state", state: "idle" });
    body.handle({ type: "state", state: "idle" });
    body.handle({ type: "state", state: "speaking" });
    expect(sink.lines).toEqual(["S idle", "S speaking"]);
  });

  it("heartbeats only while a browser is attached, so the firmware can fail safe", () => {
    let now = 0;
    const sink = new Recorder();
    const body = new BodyController(sink, ["eyes"], () => now);
    body.handle({ type: "state", state: "speaking" });
    sink.lines = [];
    now = 1000;
    body.tick();
    expect(sink.lines).toEqual(["S speaking"]);
    now = 5000;
    body.tick();
    expect(sink.lines).toEqual(["S speaking"]);
  });

  it("sends flourishes straight through, and doesn't replay them on reconnect", () => {
    const sink = new Recorder();
    const body = new BodyController(sink, ["eyes"]);
    body.handle({ type: "state", state: "idle" });
    body.handle({ type: "flourish", effect: "sparkle" });
    body.flourish("gasp");
    expect(sink.lines).toEqual(["S idle", "F sparkle", "F gasp"]);
    sink.lines = [];
    body.replay();
    expect(sink.lines.some((l) => l.startsWith("F "))).toBe(false);
  });

  it("counts a flourish as browser activity for the heartbeat", () => {
    let now = 0;
    const sink = new Recorder();
    const body = new BodyController(sink, ["eyes"], () => now);
    now = 10_000;
    body.handle({ type: "flourish", effect: "slowblink" });
    sink.lines = [];
    now = 11_000;
    body.tick();
    expect(sink.lines).toEqual(["S sleeping"]);
  });
});

describe("eye flourishes (dashboard preview)", () => {
  it("returns to the plain state look once each flourish is over", () => {
    for (const effect of ["sparkle", "gasp", "slowblink"] as const) {
      expect(flourishFrame(effect, FLOURISH_MS[effect])).toEqual({ lid: 1, wide: 0, sparkle: 0, edge: LID_OPEN });
      expect(FLOURISH_MS[effect]).toBeGreaterThanOrEqual(300);
      expect(FLOURISH_MS[effect]).toBeLessThanOrEqual(1500);
    }
  });

  it("gasps with two blinks, then goes wide-eyed", () => {
    expect(flourishFrame("gasp", 75).lid).toBeCloseTo(0); // first blink shut
    expect(flourishFrame("gasp", 185).lid).toBe(1); // open between blinks
    expect(flourishFrame("gasp", 295).lid).toBeCloseTo(0); // second blink shut
    expect(flourishFrame("gasp", 400)).toMatchObject({ lid: 1, wide: expect.closeTo(1, 1) });
  });

  it("blinks for thinking like the idle blinks: a lid down from the top and back up, never fading all the LEDs", () => {
    expect(FLOURISH_MS.slowblink).toBe(BLINK_MS);
    for (let t = 0; t < BLINK_MS; t += 5) {
      expect(flourishFrame("slowblink", t)).toMatchObject({ lid: 1, wide: 0, sparkle: 0, edge: lidEdge(t) });
    }
    expect(flourishFrame("slowblink", LID_DOWN_MS + LID_SHUT_MS / 2).edge).toBe(-LID_OPEN); // shut
  });

  const orange: [number, number, number] = [255, 106, 0];
  const steady = () => new JewelAnimator(() => 0.5);

  it("draws both jewels' 7 pixels in the state's color", () => {
    const [left, right] = steady().frame(orange, "idle", 0, "blink", PULSE_MS); // the center's purple pulse at rest
    expect(left).toHaveLength(JEWEL_PIXELS);
    expect(right).toHaveLength(JEWEL_PIXELS);
    for (const rgb of [...left!, ...right!]) expect(Math.max(...rgb)).toBeCloseTo(204); // all at 0.8 brightness
    expect(left![0]!.map(Math.round)).toEqual([204, 85, 0]); // the center keeps the exact color; the ring swirls
  });

  it("sparkles like the firmware: white centers first, a rainbow around the ring, the eyes half a turn apart", () => {
    const sparkle = { effect: "sparkle" as const, at: 0 };
    const early = steady().frame(orange, "idle", 0, "glow", 100, sparkle);
    expect(early[0]![0]).toEqual([255, 255, 255]);
    expect(early[1]![0]).toEqual([255, 255, 255]);
    const [left, right] = steady().frame(orange, "idle", 0, "glow", 500, sparkle);
    expect(new Set(left!.slice(1).map(String)).size).toBe(6); // six different ring colors
    expect(left![1]).toEqual(right![4]); // half a turn = 3 pixels around the ring
    expect(steady().frame(orange, "idle", 0, "glow", 500, sparkle, 3)[0]![3]).toEqual([255, 255, 255]); // twinkle
    expect(steady().frame(orange, "idle", 0, "glow", 500, sparkle, 10)[1]![3]).toEqual([255, 255, 255]); // on the right jewel
    expect(steady().frame(orange, "idle", 0, "glow", 1200, sparkle)).toEqual(steady().frame(orange, "idle", 0, "glow", 1200));
  });

  it("covers every pixel when the lids close", () => {
    for (const eye of steady().frame(orange, "speaking", 1, "flicker", LID_DOWN_MS + 10, { effect: "slowblink", at: 0 })) {
      for (const rgb of eye) expect(rgb).toEqual(LID_COLOR);
    }
  });

  it("spins a comet round the ring while thinking, the eyes in mirror image", () => {
    const ring = (eye: number, now: number) => [1, 2, 3, 4, 5, 6].map((p) => pixelMotion("thinking", "flicker", 0, now, eye, p).b);
    const head = (b: number[]) => b.indexOf(Math.max(...b)) + 1;
    expect(head(ring(0, 0))).toBe(1);
    expect(head(ring(0, 150))).toBe(2); // a sixth of the 900 ms turn later, one pixel on
    expect(head(ring(1, 150))).toBe(6); // the other eye goes the other way
    // The tail fades behind the head and drifts in hue.
    const b = ring(0, 150);
    expect(b[0]).toBeGreaterThan(b[5]!);
    expect(pixelMotion("thinking", "flicker", 0, 150, 0, 1).hue).toBeLessThan(0);
  });

  it("follows the voice while speaking, dim between words, rippling brightness and hue round the ring", () => {
    expect(pixelMotion("speaking", "flicker", 0, 0, 0, 0).b).toBeCloseTo(0.1);
    expect(pixelMotion("speaking", "flicker", 1, 0, 0, 0).b).toBeCloseTo(1);
    const ring = [1, 2, 3, 4, 5, 6].map((p) => pixelMotion("speaking", "flicker", 1, 0, 0, p));
    expect(Math.max(...ring.map((m) => m.b)) - Math.min(...ring.map((m) => m.b))).toBeCloseTo(0.7);
    expect(new Set(ring.map((m) => Math.round(m.hue))).size).toBeGreaterThan(2);
  });

  it("spins the speaking ripple faster the louder the voice", () => {
    expect(speakSpinRate(1)).toBeGreaterThan(5 * speakSpinRate(0));
    // Where the ripple's brightest ring pixel is after `ms` of speaking at `level`, in 16 ms frames.
    const peakAfter = (level: number, ms: number) => {
      const animator = steady();
      let frame: number[][][] = [];
      for (let t = 0; t <= ms; t += 16) frame = animator.frame([255, 208, 0], "speaking", level, "flicker", t);
      const ring = frame[0]!.slice(1).map((rgb) => Math.max(...rgb));
      return ring.indexOf(Math.max(...ring));
    };
    expect(peakAfter(0, 240)).toBe(1); // quiet: barely a pixel in 240 ms
    expect(peakAfter(0.65, 240)).toBe(3); // louder (but no whirl): half a turn (3 pixels)
  });

  it("blinks now and then while speaking: a lid comes down and goes back up", () => {
    const eyes = new LivelyEyes(() => 0.5); // 0.5: normal speed, the right eye 30 ms behind, no double
    const open = lidEdge(-1);
    const left = (t: number, state: BodyState = "speaking") => eyes.step(t, state, 0.3).lid[0];
    expect(left(0)).toBe(open);
    // The first blink comes 1.5-4 s in: 2.75 s with this "random".
    expect(left(2700)).toBe(open);
    expect(left(2750)).toBe(open); // starts at the top...
    expect(left(2750 + LID_DOWN_MS / 2)).toBeCloseTo(0); // ...halfway down...
    expect(left(2750 + LID_DOWN_MS + LID_SHUT_MS / 2)).toBe(-open); // ...shut...
    expect(left(2750 + BLINK_MS)).toBe(open); // ...and back up
    // The next after a blinkGap: 1.2 s plus 2.5 s x ln 2 with this "random".
    const next = 2750 + blinkGap(...SPEAK_BLINK_GAP, 0.5);
    expect(left(Math.ceil(next) - 1)).toBe(open);
    eyes.step(Math.ceil(next), "speaking", 0.3);
    expect(left(Math.ceil(next) + LID_DOWN_MS + LID_SHUT_MS / 2)).toBe(-open);
    // Never while listening (or thinking): they have motion enough.
    expect(left(20_000, "listening")).toBe(open);
  });

  it("blinks less often while idle or sleeping", () => {
    for (const state of ["idle", "sleeping"] as const) {
      const eyes = new LivelyEyes(() => 0.5);
      eyes.step(0, state, 0);
      eyes.step(2750, state, 0); // the first blink, 1.5-4 s in
      expect(eyes.step(2750 + LID_DOWN_MS, state, 0)).toMatchObject({ lid: [-lidEdge(-1), expect.any(Number)], whirl: 0 });
      const next = Math.ceil(2750 + blinkGap(...REST_BLINK_GAP, 0.5));
      expect(blinkGap(...REST_BLINK_GAP, 0.5)).toBeGreaterThan(blinkGap(...SPEAK_BLINK_GAP, 0.5));
      expect(eyes.step(next - 1, state, 0).lid[0]).toBe(lidEdge(-1));
      eyes.step(next, state, 0);
      expect(eyes.step(next + LID_DOWN_MS, state, 0).lid[0]).toBe(-lidEdge(-1));
    }
    // Going quiet between sentences doesn't put the next blink off.
    const eyes = new LivelyEyes(() => 0.5);
    eyes.step(0, "speaking", 0.3);
    eyes.step(2000, "idle", 0);
    eyes.step(2750, "speaking", 0.3);
    expect(eyes.step(2750 + LID_DOWN_MS, "speaking", 0.3).lid[0]).toBe(-lidEdge(-1));
    // Thinking never blinks.
    const thinking = new LivelyEyes(() => 0.5);
    for (let t = 0; t < 20_000; t += 50) expect(thinking.step(t, "thinking", 0).lid).toEqual([lidEdge(-1), lidEdge(-1)]);
  });

  it("spaces blinks unevenly: mostly a little over the minimum, now and then much longer, never past the max", () => {
    const [min, mean, max] = SPEAK_BLINK_GAP;
    expect(blinkGap(min, mean, max, 0)).toBe(min);
    expect(blinkGap(min, mean, max, 0.5)).toBeCloseTo(min + mean * Math.LN2);
    expect(blinkGap(min, mean, max, 0.9999)).toBe(max);
    const gaps = Array.from({ length: 1000 }, (_, i) => blinkGap(min, mean, max, (i + 0.5) / 1000));
    const median = gaps[500]!;
    expect(gaps.filter((g) => g > 2 * median).length).toBeGreaterThan(50); // a long tail...
    expect(gaps.filter((g) => g < median).length).toBe(500); // ...over mostly short gaps
  });

  it("varies each blink: a little faster or slower, now and then a double, the right eye just behind", () => {
    // Randoms per blink: speed, right eye's lag, double?, then the gap (when not a double). Sleeping, so no sparks draw randoms too.
    let n = 0;
    const randoms = [0.5 /* first blink's delay */, 1, 1, 0 /* a double */, 0, 0, 0.9, 0.5];
    const eyes = new LivelyEyes(() => randoms[n++] ?? 0.5);
    eyes.step(0, "sleeping", 0);
    eyes.step(2750, "sleeping", 0); // slowest (1.15x), the right eye 40 ms behind
    const shut = (t: number) => eyes.step(2750 + t, "sleeping", 0).lid;
    expect(shut(LID_DOWN_MS * 1.15 + 10)).toEqual([-lidEdge(-1), expect.any(Number)]);
    expect(shut(LID_DOWN_MS * 1.15 + 10)[1]).toBeGreaterThan(-lidEdge(-1)); // the right eye isn't shut yet
    expect(shut(BLINK_MS * 1.15 - 1)[0]).toBeLessThan(lidEdge(-1)); // a slow blink is still going...
    expect(shut(BLINK_MS * 1.15 + 1)[0]).toBe(lidEdge(-1)); // ...then done
    // The double: the next blink straight after this one (and the right eye's lag) ends.
    const again = Math.ceil(2750 + BLINK_MS * 1.15 + 40 + DOUBLE_BLINK_GAP_MS);
    expect(eyes.step(again - 1, "sleeping", 0).lid[0]).toBe(lidEdge(-1));
    eyes.step(again, "sleeping", 0); // fastest (0.85x), the right eye 20 ms behind
    expect(eyes.step(again + LID_DOWN_MS * 0.85 + 5, "sleeping", 0).lid[0]).toBe(-lidEdge(-1));
    expect(eyes.step(again + BLINK_MS * 0.85 + 1, "sleeping", 0).lid[0]).toBe(lidEdge(-1));
    expect(DOUBLE_BLINK_ODDS).toBeCloseTo(1 / 6);
  });

  it("covers the eye from the top down", () => {
    const bottom = ((EYE_TOP_PIXEL + 2) % 6) + 1;
    const all = [0, 1, 2, 3, 4, 5, 6];
    expect(all.map((p) => lidCover(lidEdge(-1), p))).toEqual(all.map(() => 0)); // open
    expect(all.map((p) => lidCover(lidEdge(LID_DOWN_MS), p))).toEqual(all.map(() => 1)); // shut
    expect(lidCover(0, EYE_TOP_PIXEL)).toBe(1); // halfway: the top is covered...
    expect(lidCover(0, 0)).toBe(0.5); // ...the center half...
    expect(lidCover(0, bottom)).toBe(0); // ...the bottom not yet
    // In the preview: the top pixel goes black while the bottom keeps the eye color.
    const animator = new JewelAnimator(() => 0.5);
    let frame: number[][][] = [];
    for (let t = 0; t <= 2750 + LID_DOWN_MS / 2; t += 5) frame = animator.frame([255, 208, 0], "speaking", 0.5, "flicker", t);
    expect(frame[0]![EYE_TOP_PIXEL]).toEqual(LID_COLOR);
    expect(frame[0]![bottom]![1]).toBeGreaterThan(20); // still yellow
    // The right eye is 30 ms behind with this "random": its lid not yet all the way over the top pixel.
    expect(frame[1]![EYE_TOP_PIXEL]![1]).toBeGreaterThan(0);
  });

  it("whirls when the voice jumps loud, at most every 5 s, at least every 9 s", () => {
    const eyes = new LivelyEyes(() => 0.5);
    expect(eyes.step(0, "speaking", 0.3).whirl).toBe(0);
    expect(eyes.step(100, "speaking", WHIRL_PEAK).whirl).toBe(0); // starts...
    expect(eyes.step(100 + WHIRL_MS / 2, "speaking", 0.9).whirl).toBeCloseTo(4); // ...flat out halfway...
    expect(eyes.step(100 + WHIRL_MS, "speaking", 0.9).whirl).toBe(0); // ...and done
    eyes.step(1000, "speaking", 0.3);
    eyes.step(1100, "speaking", 0.9); // loud again, but too soon
    expect(eyes.step(1100 + WHIRL_MS / 2, "speaking", 0.9).whirl).toBe(0);
    eyes.step(100 + WHIRL_COOLDOWN_MS, "speaking", 0.3);
    eyes.step(200 + WHIRL_COOLDOWN_MS, "speaking", 0.9); // loud after the cooldown: whirls
    expect(eyes.step(200 + WHIRL_COOLDOWN_MS + WHIRL_MS / 2, "speaking", 0.9).whirl).toBeCloseTo(4);
    // A long, even answer still gets one.
    const steadyTalk = new LivelyEyes(() => 0.5);
    steadyTalk.step(0, "speaking", 0.3);
    expect(steadyTalk.step(WHIRL_AT_LEAST_EVERY_MS - 100, "speaking", 0.3).whirl).toBe(0);
    steadyTalk.step(WHIRL_AT_LEAST_EVERY_MS, "speaking", 0.3);
    expect(steadyTalk.step(WHIRL_AT_LEAST_EVERY_MS + WHIRL_MS / 2, "speaking", 0.3).whirl).toBeCloseTo(4);
  });

  it("spins the ripple about 1.5 extra turns in a whirl", () => {
    let turns = 0;
    for (let t = 0; t < WHIRL_MS; t++) turns += whirlRate(t) / 1000;
    expect(turns).toBeCloseTo(1.53, 1);
    expect(whirlRate(WHIRL_MS)).toBe(0);
  });

  it("breathes the idle center toward dark purple and back", () => {
    expect(idlePulse(0)).toBe(0);
    expect(idlePulse(PULSE_MS / 2)).toBeCloseTo(0.8);
    expect(idlePulse(PULSE_MS)).toBeCloseTo(0);
    const center = (now: number) => steady().frame(orange, "idle", 0, "glow", now)[0]![0]!;
    expect(center(PULSE_MS / 2)[2]).toBeGreaterThan(50); // purple: plenty of blue
    expect(center(PULSE_MS)[2]).toBeCloseTo(0); // back to plain orange
    expect(steady().frame(orange, "listening", 0, "glow", PULSE_MS / 2)[0]![0]![2]).toBe(0); // idle only
  });

  it("races a spark round the ring, a tail behind it, fading in and out", () => {
    const ring = (t: number, from: number, dir: number) => [1, 2, 3, 4, 5, 6].map((p) => sparkAt(t, from, dir, p));
    const head = (k: number[]) => k.indexOf(Math.max(...k));
    expect(sparkAt(IDLE_SPIN_MS / 2, 0, 1, 0)).toBe(0); // never the center
    expect(Math.max(...ring(0, 2, 1))).toBe(0); // fades in...
    expect(Math.max(...ring(IDLE_SPIN_MS, 2, 1))).toBe(0); // ...and is gone at the end
    // Starts at its pixel; a tail fades out behind the head, which way round depends on `dir`.
    const forward = ring(200, 2, 1);
    expect(head(forward)).toBe(2);
    expect(forward[1]).toBeGreaterThan(0);
    expect(forward[3]).toBe(0);
    const backward = ring(200, 2, -1);
    expect(head(backward)).toBe(2);
    expect(backward[3]).toBeGreaterThan(0);
    expect(backward[1]).toBe(0);
    // Halfway through it has gone round IDLE_SPIN_TURNS / 2 times: back at its pixel.
    expect(head(ring(IDLE_SPIN_MS / 2, 2, 1))).toBe(2);
    expect(IDLE_SPIN_TURNS).toBe(2);
  });

  it("spins a spark every 3-7 s while idle, a random way round, the eyes in mirror image", () => {
    let n = 0;
    const randoms = [0.5, 0.5, 0.5, 0.2, 0.9]; // blink, spin delay, spin pixel, way round, next spin...
    const eyes = new LivelyEyes(() => randoms[n++ % randoms.length]!);
    eyes.step(0, "idle", 0);
    expect(eyes.step(1999, "idle", 0).spin).toBeNull(); // the first one 1-3 s in: 2 s here
    expect(eyes.step(2000, "idle", 0).spin).toEqual({ t: 0, from: 3, dir: 1 });
    expect(eyes.step(2000 + IDLE_SPIN_MS - 1, "idle", 0).spin?.t).toBe(IDLE_SPIN_MS - 1);
    expect(eyes.step(2000 + IDLE_SPIN_MS, "idle", 0).spin).toBeNull();
    // Only while idle.
    const talking = new LivelyEyes(() => 0.5);
    for (let t = 0; t < 20_000; t += 50) expect(talking.step(t, "speaking", 0.3).spin).toBeNull();
    // In the preview: the spark is warm white, the right eye's mirrored round the top pixel.
    const animator = new JewelAnimator(() => 0.5);
    let frame: number[][][] = [];
    for (let t = 0; t <= 2000 + 150; t += 10) frame = animator.frame(orange, "idle", 0, "glow", t);
    // From ring pixel 3 with this "random"; 150 ms in, it has barely moved: nearly all spark.
    for (const [k, c] of SPARK_COLOR.entries()) expect(Math.abs(frame[0]![4]![k]! - c)).toBeLessThan(15);
    expect(frame[1]![4]).toEqual(frame[0]![4]); // ring pixel 3 mirrors to itself
    expect(frame[0]![2]![2]).toBeCloseTo(0); // pixels away from the spark keep the plain orange
  });

  it("keeps the speaking blinks and whirls in step with the firmware", () => {
    const firmware = readFileSync(new URL("../firmware/creature_body/creature_body.ino", import.meta.url), "utf8");
    expect(firmware).toContain(`BLINK_MS = ${BLINK_MS};`);
    expect(firmware).toContain(`SPEAK_BLINK_GAP[3] = {${SPEAK_BLINK_GAP.join(", ")}};`);
    expect(firmware).toContain(`REST_BLINK_GAP[3] = {${REST_BLINK_GAP.join(", ")}};`);
    expect(firmware).toContain(`DOUBLE_BLINK_ODDS = ${Math.round(1 / DOUBLE_BLINK_ODDS)};`);
    expect(firmware).toContain(`DOUBLE_BLINK_GAP_MS = ${DOUBLE_BLINK_GAP_MS};`);
    expect(firmware).toContain(`LID_DOWN_MS = ${LID_DOWN_MS};`);
    expect(firmware).toContain(`LID_SHUT_MS = ${LID_SHUT_MS};`);
    expect(firmware).toContain(`LID_COLOR[3] = {${LID_COLOR.join(", ")}};`);
    expect(firmware).toContain(`EYE_TOP_PIXEL = ${EYE_TOP_PIXEL};`);
    expect(firmware).toContain(`WHIRL_MS = ${WHIRL_MS};`);
    expect(firmware).toContain(`IDLE_SPIN_MS = ${IDLE_SPIN_MS};`);
    expect(firmware).toContain(`IDLE_SPIN_TURNS = ${IDLE_SPIN_TURNS};`);
    expect(firmware).toContain(`SPARK_COLOR[3] = {${SPARK_COLOR.join(", ")}};`);
    expect(firmware).toContain(`PULSE_MS = ${PULSE_MS};`);
    expect(firmware).toContain(`PULSE_COLOR[3] = {${PULSE_COLOR.join(", ")}};`);
    expect(firmware).toContain(`WHIRL_PEAK = ${WHIRL_PEAK};`);
    expect(firmware).toContain(`WHIRL_COOLDOWN_MS = ${WHIRL_COOLDOWN_MS};`);
    expect(firmware).toContain(`WHIRL_AT_LEAST_EVERY_MS = ${WHIRL_AT_LEAST_EVERY_MS};`);
  });

  it("flickers each LED on its own when idle, like a candle", () => {
    let n = 0;
    const animator = new JewelAnimator(() => (n++ % 7) / 7);
    animator.frame(orange, "idle", 0, "flicker", 0);
    const [left] = animator.frame(orange, "idle", 0, "flicker", 20);
    expect(new Set(left!.map(String)).size).toBeGreaterThan(1);
    expect(pixelMotion("idle", "blink", 0, 4100, 0, 3).b).toBe(0.05);
    expect(pixelMotion("sleeping", "flicker", 0, 0, 0, 0).b).toBe(0.2);
  });

  it("shifts hue round the color wheel, keeping brightness", () => {
    expect(shiftHue([255, 0, 0], 120).map(Math.round)).toEqual([0, 255, 0]);
    expect(shiftHue([255, 0, 0], -120).map(Math.round)).toEqual([0, 0, 255]);
    expect(shiftHue([200, 200, 200], 90)).toEqual([200, 200, 200]); // grey has no hue
    expect(shiftHue(orange, 0)).toEqual(orange);
  });

  it("greets new visitors and costume changes with a sparkle, and a welcome back with a gasp", () => {
    expect(GREETING_FLOURISH).toEqual({ visitors: "sparkle", costume: "sparkle", "welcome-back": "gasp" });
  });
});

describe("BodyLink flourishes", () => {
  it("slow-blinks on starting to think, unless a flourish is playing or one just did", () => {
    const link = new BodyLink();
    link.setState("idle", 0);
    link.setState("thinking", 1000);
    expect(link.activeFlourish(1000)).toEqual({ effect: "slowblink", at: 1000 });
    expect(link.activeFlourish(1000 + FLOURISH_MS.slowblink)).toBeNull();

    // Flapping in and out of thinking doesn't keep blinking.
    link.setState("idle", 3000);
    link.setState("thinking", 3500);
    expect(link.activeFlourish(3500)).toBeNull();

    // A greeting's sparkle isn't cut short by the thinking blink.
    link.flourish("sparkle", 10_000);
    link.setState("idle", 10_100);
    link.setState("thinking", 10_200);
    expect(link.activeFlourish(10_200)?.effect).toBe("sparkle");
  });
});

describe("deriveBodyState", () => {
  const quiet = { awake: true, live: true, speaking: false, thinking: false, sinceHeardMs: 10_000 };

  it("is idle while awake with nobody around, even with the voice session asleep (autopilot waiting)", () => {
    expect(deriveBodyState({ ...quiet, live: false })).toBe("idle");
    expect(deriveBodyState(quiet)).toBe("idle");
  });

  it("sleeps only when the creature does (the kill switch)", () => {
    expect(deriveBodyState({ ...quiet, awake: false, live: false })).toBe("sleeping");
  });

  it("speaks, thinks and listens as before", () => {
    expect(deriveBodyState({ ...quiet, speaking: true, thinking: true })).toBe("speaking");
    expect(deriveBodyState({ ...quiet, live: false, speaking: true })).toBe("speaking"); // a recorded clip
    expect(deriveBodyState({ ...quiet, thinking: true, sinceHeardMs: 0 })).toBe("thinking");
    expect(deriveBodyState({ ...quiet, sinceHeardMs: 1000 })).toBe("listening");
    expect(deriveBodyState({ ...quiet, live: false, thinking: true })).toBe("idle"); // no session, nothing to wait on
  });
});

describe("BodyLink keep-alive", () => {
  it("re-sends a steady state, so the server keeps the body awake instead of letting it fail safe to sleeping", () => {
    let now = 0;
    const sink = new Recorder();
    const body = new BodyController(sink, ["eyes"], () => now);
    const link = new BodyLink();
    let sent = 0;
    (link as unknown as { ws: unknown }).ws = {
      readyState: WebSocket.OPEN,
      send: (m: string) => {
        sent++;
        body.handle(JSON.parse(m) as BodyMessage);
      },
    };
    // 20 s of idle with nobody talking, drawn at 60 fps, the server ticking every 500 ms.
    for (; now <= 20_000; now += 16) {
      link.setState("idle", now);
      if (now % 500 < 16) body.tick();
    }
    sink.lines = [];
    body.tick();
    expect(sink.lines).toEqual(["S idle"]); // still heartbeating
    expect(sent).toBeGreaterThanOrEqual(20);
    expect(sent).toBeLessThanOrEqual(22); // about once a second, not every frame
  });
});

describe("pickArduinoPort", () => {
  // As macOS reported them: a USB-C hub's billboard device, and an FTDI-based Uno.
  const ankerHub = { path: "/dev/tty.usbmodemSN234567892", vendorId: "291a" };
  const ftdiUno = { path: "/dev/tty.usbserial-A5069RR4", vendorId: "0403" };

  it("picks a known Arduino or USB-serial vendor over a merely Arduino-like name", () => {
    expect(pickArduinoPort([ankerHub, ftdiUno])).toBe(ftdiUno.path);
  });

  it("never picks a port from another vendor, even if it's named like an Arduino", () => {
    expect(pickArduinoPort([ankerHub])).toBeUndefined();
  });

  it("falls back to the name only for ports that report no vendor", () => {
    expect(pickArduinoPort([{ path: "/dev/ttyACM0" }])).toBe("/dev/ttyACM0");
    expect(pickArduinoPort([{ path: "/dev/tty.Bluetooth-Incoming-Port" }])).toBeUndefined();
  });
});
