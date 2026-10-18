import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMBIENT_SOUNDS } from "../web/ambience.ts";
import { PorchSoundPlayer } from "../web/porchSounds.ts";

/** Just enough Web Audio to see which nodes are still wired to the output. */
class FakeNode {
  readonly outputs = new Set<FakeNode>();
  gain = param();
  frequency = param();
  Q = param();
  type = "";
  buffer: unknown = null;
  loop = false;
  connect<T>(node: T): T {
    this.outputs.add(node as unknown as FakeNode);
    return node;
  }
  disconnect(): void {
    this.outputs.clear();
  }
  start(): void {}
  stop(): void {}
}

function param() {
  return { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} };
}

class FakeContext {
  currentTime = 0;
  sampleRate = 8000;
  readonly nodes: FakeNode[] = [];
  private make = () => {
    const node = new FakeNode();
    this.nodes.push(node);
    return node;
  };
  createGain = this.make;
  createOscillator = this.make;
  createBiquadFilter = this.make;
  createBufferSource = this.make;
  createMediaStreamDestination = () => Object.assign(this.make(), { stream: {} });
  createBuffer = (_channels: number, length: number) => ({ duration: length / this.sampleRate, getChannelData: () => new Float32Array(length) });
}

/** Nodes from which the output (the first gain the player made) can still be reached. */
function wiredToOutput(ctx: FakeContext): number {
  const out = ctx.nodes[1]!;
  const reaches = (node: FakeNode, seen = new Set<FakeNode>()): boolean => {
    if (node === out) return true;
    if (!(node instanceof FakeNode) || seen.has(node)) return false; // an AudioParam (vibrato) ends the path
    seen.add(node);
    return [...node.outputs].some((n) => reaches(n, seen));
  };
  return ctx.nodes.filter((n) => n !== out && n !== ctx.nodes[0] && reaches(n)).length;
}

describe("PorchSoundPlayer", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: () => ({ play: () => Promise.resolve(), autoplay: false, srcObject: null }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unhooks each ambient sound once it has finished by itself", () => {
    // Found by the soak test: every finished sound stayed connected, so its nodes were never freed.
    const ctx = new FakeContext();
    const player = new PorchSoundPlayer(ctx as unknown as AudioContext);
    for (const sound of AMBIENT_SOUNDS) {
      player.playAmbience(sound);
      expect(player.playing).toBe("ambience");
      expect(wiredToOutput(ctx)).toBeGreaterThan(1);
      ctx.currentTime += 30;
      expect(player.playing).toBeNull();
      expect(wiredToOutput(ctx)).toBe(0);
    }
  });

  it("unhooks a call-out once it has played", () => {
    const ctx = new FakeContext();
    const player = new PorchSoundPlayer(ctx as unknown as AudioContext);
    player.clips = [{ buffer: { duration: 2 } as AudioBuffer, text: "Psst!" }];
    expect(player.playLure(0)).toBe("Psst!");
    expect(wiredToOutput(ctx)).toBe(2);
    ctx.currentTime = 2.5;
    expect(player.playing).toBeNull();
    expect(wiredToOutput(ctx)).toBe(0);
  });
});
