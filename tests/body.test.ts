import { describe, expect, it } from "vitest";
import { BodyController, pickArduinoPort, type LineSink } from "../server/body/driver.ts";
import { encodeFlourish, encodeLevel, encodeModes, encodePalette, encodeState } from "../server/body/protocol.ts";
import type { EyePalette } from "../shared/types.ts";
import { BodyLink } from "../web/bodyLink.ts";
import { FLOURISH_MS, flourishFrame, GREETING_FLOURISH, JEWEL_PIXELS, JewelAnimator, pixelMotion, shiftHue } from "../web/eyeFlourish.ts";

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
      expect(flourishFrame(effect, FLOURISH_MS[effect])).toEqual({ lid: 1, wide: 0, sparkle: 0 });
      expect(FLOURISH_MS[effect]).toBeGreaterThanOrEqual(500);
      expect(FLOURISH_MS[effect]).toBeLessThanOrEqual(1500);
    }
  });

  it("gasps with two blinks, then goes wide-eyed", () => {
    expect(flourishFrame("gasp", 75).lid).toBeCloseTo(0); // first blink shut
    expect(flourishFrame("gasp", 185).lid).toBe(1); // open between blinks
    expect(flourishFrame("gasp", 295).lid).toBeCloseTo(0); // second blink shut
    expect(flourishFrame("gasp", 400)).toMatchObject({ lid: 1, wide: expect.closeTo(1, 1) });
  });

  it("closes slowly for a thinking blink, rests, and opens", () => {
    expect(flourishFrame("slowblink", 275).lid).toBeCloseTo(0.5);
    expect(flourishFrame("slowblink", 700).lid).toBe(0);
    expect(flourishFrame("slowblink", 1399).lid).toBeCloseTo(1, 2);
  });

  const orange: [number, number, number] = [255, 106, 0];
  const steady = () => new JewelAnimator(() => 0.5);

  it("draws both jewels' 7 pixels in the state's color", () => {
    const [left, right] = steady().frame(orange, "idle", 0, "blink", 1000);
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

  it("dims every pixel when the lids close", () => {
    for (const eye of steady().frame(orange, "speaking", 1, "flicker", 700, { effect: "slowblink", at: 0 })) {
      for (const rgb of eye) expect(rgb).toEqual([0, 0, 0]);
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

  it("follows the voice while speaking, rippling brightness and hue round the ring", () => {
    expect(pixelMotion("speaking", "flicker", 0, 0, 0, 0).b).toBeCloseTo(0.35);
    expect(pixelMotion("speaking", "flicker", 1, 0, 0, 0).b).toBeCloseTo(1);
    const ring = [1, 2, 3, 4, 5, 6].map((p) => pixelMotion("speaking", "flicker", 1, 0, 0, p));
    expect(Math.max(...ring.map((m) => m.b)) - Math.min(...ring.map((m) => m.b))).toBeCloseTo(0.4, 1);
    expect(new Set(ring.map((m) => Math.round(m.hue))).size).toBeGreaterThan(2);
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
