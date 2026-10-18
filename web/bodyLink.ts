import type { BodyMessage, BodyState, CharacterInfo } from "../shared/types.ts";

/** WebSocket to the local server, which forwards body commands to the Arduino. */
export class BodyLink {
  private ws: WebSocket | null = null;
  private state: BodyState = "sleeping";
  private palette: CharacterInfo | null = null;
  private lastLevelSentAt = 0;
  private lastLevel = 0;

  connect(): void {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/body`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.palette) this.sendPalette(this.palette);
      this.raw({ type: "state", state: this.state });
    });
    ws.addEventListener("close", () => setTimeout(() => this.connect(), 2000));
  }

  sendPalette(character: CharacterInfo): void {
    this.palette = character;
    this.raw({ type: "palette", eyes: character.eyes, eyeStyle: character.eyeStyle });
  }

  setState(state: BodyState): void {
    if (state === this.state) return;
    this.state = state;
    this.raw({ type: "state", state });
  }

  /** Throttled to ~30 messages a second; repeats of silence are skipped. */
  setLevel(level: number, now: number): void {
    if (now - this.lastLevelSentAt < 33) return;
    if (level < 0.01 && this.lastLevel < 0.01) return;
    this.lastLevelSentAt = now;
    this.lastLevel = level;
    this.raw({ type: "level", level });
  }

  private raw(msg: BodyMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
