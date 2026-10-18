import { describe, expect, it } from "vitest";
import { BodyController, pickArduinoPort, type LineSink } from "../server/body/driver.ts";
import { encodeFlourish, encodeLevel, encodeModes, encodePalette, encodeState } from "../server/body/protocol.ts";
import type { EyePalette } from "../shared/types.ts";
import { BodyLink } from "../web/bodyLink.ts";
import { eyeLook, FLOURISH_MS, flourishFrame, GREETING_FLOURISH } from "../web/eyeFlourish.ts";

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

  it("sparkles over the state color, with the two eyes on different colors, then fades back", () => {
    const at = 0;
    const left = eyeLook([255, 106, 0], 0.8, { effect: "sparkle", at }, 500, 0);
    const right = eyeLook([255, 106, 0], 0.8, { effect: "sparkle", at }, 500, 1);
    expect(left.rgb).not.toEqual(right.rgb);
    expect(left.brightness).toBe(1);
    expect(eyeLook([255, 106, 0], 0.8, { effect: "sparkle", at }, 1200, 0)).toEqual(eyeLook([255, 106, 0], 0.8, null, 1200, 0));
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
