import { describe, expect, it } from "vitest";
import { describeError, resolveDevice } from "../web/devices.ts";

const c920 = { kind: "videoinput" as const, deviceId: "new-id", label: "HD Pro Webcam C920 (046d:08e5)" };
const builtIn = { kind: "videoinput" as const, deviceId: "mac-cam", label: "MacBook Pro Camera" };
const usbAudio = { kind: "audiooutput" as const, deviceId: "spk", label: "USB Audio Device" };

describe("resolveDevice", () => {
  it("finds a saved device by id", () => {
    expect(resolveDevice([builtIn, c920], "videoinput", { id: "mac-cam" })).toBe(builtIn);
  });

  it("finds it by name when it came back with a new id (re-plugged into another hub)", () => {
    expect(resolveDevice([builtIn, c920], "videoinput", { id: "old-id", label: c920.label })).toBe(c920);
  });

  it("only matches devices of the right kind, and gives up (use the default) when it's gone", () => {
    expect(resolveDevice([usbAudio], "videoinput", { label: "USB Audio Device" })).toBeUndefined();
    expect(resolveDevice([builtIn], "videoinput", { id: "old-id", label: c920.label })).toBeUndefined();
    expect(resolveDevice([builtIn], "videoinput", {})).toBeUndefined();
  });
});

describe("describeError", () => {
  it("names errors that have no message, like a stale camera id", () => {
    const err = Object.assign(new Error(""), { name: "OverconstrainedError" });
    expect(describeError(err)).toBe("OverconstrainedError");
    expect(describeError(new TypeError("bad"))).toBe("TypeError: bad");
  });
});
