/**
 * Measures how loud the creature's voice is, for the eyes/jaw and "is speaking": the live voice
 * (a MediaStream), or the recorded clips (a Web Audio node, see PorchSoundPlayer.voiceTap).
 */
export class VoiceMeter {
  level = 0;
  private analyser: AnalyserNode | null = null;
  private source: AudioNode | null = null;
  private data = new Float32Array(1024);
  private lastLoudAt = -Infinity;

  constructor(
    private readonly ctx: AudioContext,
    private readonly threshold = 0.05,
    private readonly hangoverMs = 450,
  ) {}

  attach(stream: MediaStream | null): void {
    this.attachNode(stream && stream.getAudioTracks().length > 0 ? this.ctx.createMediaStreamSource(stream) : null);
  }

  /** Follows an audio node already in this context (null: stop measuring). */
  attachNode(node: AudioNode | null): void {
    if (this.source && this.analyser) {
      try {
        this.source.disconnect(this.analyser);
      } catch {
        /* wasn't connected */
      }
    }
    this.source = null;
    this.level = 0;
    if (!node) return;
    this.analyser ??= Object.assign(this.ctx.createAnalyser(), { fftSize: 1024 });
    this.source = node;
    this.source.connect(this.analyser);
  }

  /** Call every animation frame; returns a smoothed 0..1 level. */
  sample(now: number): number {
    if (!this.analyser || !this.source) {
      this.level = 0;
      return 0;
    }
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (const v of this.data) sum += v * v;
    const rms = Math.sqrt(sum / this.data.length);
    const target = Math.min(1, rms * 4);
    // Fast attack, slower release looks natural on eyes and jaws.
    this.level += (target - this.level) * (target > this.level ? 0.6 : 0.15);
    if (this.level > this.threshold) this.lastLoudAt = now;
    return this.level;
  }

  /** When the voice was last above the speaking threshold. */
  get lastLoudTime(): number {
    return this.lastLoudAt;
  }

  speaking(now: number): boolean {
    return now - this.lastLoudAt < this.hangoverMs;
  }
}
