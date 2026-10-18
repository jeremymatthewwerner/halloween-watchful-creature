import { describe, expect, it } from "vitest";
import { BodyController, pickArduinoPort, type LineSink } from "../server/body/driver.ts";
import { encodeLevel, encodeModes, encodePalette, encodeState } from "../server/body/protocol.ts";
import type { EyePalette } from "../shared/types.ts";

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
