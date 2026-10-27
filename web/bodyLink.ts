import type { BodyMessage, BodyState, CharacterInfo, EyeFlourish } from "../shared/types.ts";
import { FLOURISH_MS, type ActiveFlourish } from "./eyeFlourish.ts";

/** At most one automatic thinking blink this often, so a flickery "thinking" state doesn't keep blinking. */
const THINKING_BLINK_EVERY_MS = 5000;
/**
 * The state is re-sent this often even when it hasn't changed. The server only keeps the body awake
 * for a few seconds after the page's last message, so without this a steady state (idle with nobody
 * talking) let the Arduino's fail-safe drop the eyes to sleeping.
 */
const STATE_KEEPALIVE_MS = 1000;

/** WebSocket to the local server, which forwards body commands to the Arduino. */
export class BodyLink {
  private ws: WebSocket | null = null;
  private state: BodyState = "sleeping";
  private palette: CharacterInfo | null = null;
  private lastLevelSentAt = 0;
  private lastLevel = 0;
  private flourishing: ActiveFlourish | null = null;
  private lastThinkingBlinkAt = -Infinity;
  private lastStateSentAt = -Infinity;

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

  /** Starting to think gets a blink, unless another flourish is playing. */
  setState(state: BodyState, now = performance.now()): void {
    if (state === this.state) {
      if (now - this.lastStateSentAt >= STATE_KEEPALIVE_MS) this.sendState(now);
      return;
    }
    this.state = state;
    this.sendState(now);
    if (state === "thinking" && !this.activeFlourish(now) && now - this.lastThinkingBlinkAt >= THINKING_BLINK_EVERY_MS) {
      this.lastThinkingBlinkAt = now;
      this.flourish("slowblink", now);
    }
  }

  /** Plays a one-shot eye animation on the body (and the dashboard preview). */
  flourish(effect: EyeFlourish, now = performance.now()): void {
    this.flourishing = { effect, at: now };
    this.raw({ type: "flourish", effect });
  }

  /** The flourish playing at `now`, if any (for the eye preview). */
  activeFlourish(now: number): ActiveFlourish | null {
    const f = this.flourishing;
    return f && now - f.at < FLOURISH_MS[f.effect] ? f : null;
  }

  /** Throttled to ~30 messages a second; repeats of silence are skipped. */
  setLevel(level: number, now: number): void {
    if (now - this.lastLevelSentAt < 33) return;
    if (level < 0.01 && this.lastLevel < 0.01) return;
    this.lastLevelSentAt = now;
    this.lastLevel = level;
    this.raw({ type: "level", level });
  }

  private sendState(now: number): void {
    this.lastStateSentAt = now;
    this.raw({ type: "state", state: this.state });
  }

  private raw(msg: BodyMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
