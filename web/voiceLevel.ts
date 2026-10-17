/** Measures how loud the creature's voice is, for the eyes/jaw and "is speaking". */
export class VoiceMeter {
  level = 0;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private data = new Float32Array(1024);
  private lastLoudAt = -Infinity;

  constructor(
    private readonly ctx: AudioContext,
    private readonly threshold = 0.05,
    private readonly hangoverMs = 450,
  ) {}

  attach(stream: MediaStream | null): void {
    this.source?.disconnect();
    this.source = null;
    this.level = 0;
    if (!stream || stream.getAudioTracks().length === 0) return;
    this.analyser ??= Object.assign(this.ctx.createAnalyser(), { fftSize: 1024 });
    this.source = this.ctx.createMediaStreamSource(stream);
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

  speaking(now: number): boolean {
    return now - this.lastLoudAt < this.hangoverMs;
  }
}
