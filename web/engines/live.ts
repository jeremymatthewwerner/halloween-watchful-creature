import { WebRtcEngine, withTimeout } from "./base.ts";
import type { Engine, GreetReason } from "./types.ts";

type ServerEvent = { type: string; [key: string]: unknown };

const GREETING: Record<GreetReason, (seen: string) => string> = {
  arrived: (seen) => `[CAMERA] New visitors just walked up to you. What you see: ${seen} Greet them now and compliment their costumes.`,
  grew: (seen) => `[CAMERA] More visitors just joined the group. What you see now: ${seen} Welcome the newcomers and compliment their costumes.`,
  manual: (seen) => `[CAMERA] What you see right now: ${seen} Greet whoever is there and compliment their costumes.`,
  // "returned" is resolved to "arrived" (new visitors) or a welcome-back before speaking.
  returned: (seen) => `[CAMERA] New visitors just walked up to you. What you see: ${seen} Greet them now and compliment their costumes.`,
};

/** Same visitors back after at least this long get a quick "welcome back"; sooner, silence. */
const WELCOME_BACK_AFTER_MS = 45_000;

/**
 * GPT-Live engine (gpt-live-1) using client delegation. GPT-Live can't take images,
 * so camera frames go to the server's vision backend and come back as text:
 *  - greetings     → session.commentary.append (spoken, paraphrased in character)
 *  - background    → session.thinking.append (known, not spoken)
 *  - delegations   → a fresh look, returned with the delegation's id
 */
export class LiveEngine extends WebRtcEngine implements Engine {
  readonly kind = "live" as const;
  private onStarted: (() => void) | null = null;
  private onClosed: (() => void) | null = null;
  private lastObservation = "";
  /** How the current/most recent group was described when greeted. */
  private lastGroup = "";
  private eventSeq = 0;
  private lastSpokeAt = 0;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  /** If a greeting hasn't started this long after we asked, nudge with an instruction. */
  protected nudgeMs = 5000;

  protected waitUntilReady(): Promise<void> {
    return new Promise((resolve) => (this.onStarted = resolve));
  }

  protected onServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case "session.started":
        this.lastObservation = "";
        this.lastGroup = "";
        this.onStarted?.();
        this.onStarted = null;
        // Apply the director's mic gating to the new session as well as the local track.
        this.send({ type: this.micEnabled ? "session.input_audio.unmute" : "session.input_audio.mute", event_id: this.nextId("mic") });
        break;
      case "session.closed": {
        const usage = event.usage as { seconds?: number } | undefined;
        if (usage?.seconds !== undefined) this.emit({ type: "usage", voiceSeconds: usage.seconds });
        this.emit({ type: "note", text: `session closed (${String(event.reason ?? "unknown")})` });
        this.onClosed?.();
        this.teardown(String(event.reason ?? "closed"));
        break;
      }
      case "session.input_transcript.delta":
        this.heardAt = performance.now();
        this.emit({ type: "transcript", who: "visitor", delta: String(event.delta ?? "") });
        break;
      case "session.output_transcript.delta":
        this.lastSpokeAt = Date.now();
        this.emit({ type: "transcript", who: "creature", delta: String(event.delta ?? "") });
        break;
      case "session.delegation.created": {
        const delegation = event.delegation as { id?: string; target?: string } | undefined;
        if (delegation?.id && delegation.target !== "responses") void this.handleDelegation(delegation.id);
        break;
      }
      case "session.usage.updated": {
        const usage = event.usage as { seconds?: number } | undefined;
        if (usage?.seconds !== undefined) this.emit({ type: "usage", voiceSeconds: usage.seconds });
        break;
      }
      case "error": {
        const error = event.error as { message?: string; code?: string } | undefined;
        this.emit({ type: "error", message: `${error?.code ?? "error"}: ${error?.message ?? "unknown"}` });
        break;
      }
    }
  }

  async greet(image: string | null, reason: GreetReason, opts: { awayMs?: number } = {}): Promise<void> {
    let seen = "Your eyes aren't working right now, so you can't see their costumes; ask what they're dressed as.";
    let sameGroup = false;
    if (image) {
      try {
        const previous = reason === "returned" && this.lastGroup ? this.lastGroup : undefined;
        const result = await this.look(image, reason, { previous });
        seen = result.text;
        sameGroup = Boolean(previous) && result.sameGroup === true;
      } catch (err) {
        this.emit({ type: "error", message: `vision: ${(err as Error).message}` });
        seen = "It's too hard to see their costumes right now; ask what they're dressed as.";
      }
    }
    this.lastObservation = seen;
    if (reason === "returned") {
      if (sameGroup) {
        this.emit({ type: "note", text: `same visitors as before (vision saw: ${seen})` });
        if ((opts.awayMs ?? 0) >= WELCOME_BACK_AFTER_MS) {
          this.append("session.commentary.append", null, `[CAMERA] The same visitors you were talking to are back: ${seen} Give them a quick, fun "welcome back".`);
        } else {
          this.append("session.thinking.append", null, `[CAMERA] Background update, for reference only (don't greet again): ${seen}`);
        }
        return;
      }
      this.emit({ type: "note", text: `new visitors (vision saw: ${seen})` });
    }
    if (reason !== "grew") this.lastGroup = seen;
    else this.lastGroup = `${this.lastGroup} ${seen}`.trim();
    this.append("session.commentary.append", null, GREETING[reason](seen));
    this.scheduleNudge();
  }

  /**
   * GPT-Live's docs say appended context "may" be spoken, not that it will be.
   * If the creature stays silent after a greeting request, ask more firmly, once.
   */
  private scheduleNudge(): void {
    const sentAt = Date.now();
    const sentAtPerf = performance.now();
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      // Spoken = a transcript arrived or the voice was audible (transcripts can lag or be missing).
      const spoke = this.lastSpokeAt >= sentAt || this.deps.lastVoiceAt() >= sentAtPerf;
      if (this.status !== "open" || spoke) return;
      this.emit({ type: "note", text: "greeting didn't start; nudging" });
      this.append(
        "session.instructions.append",
        null,
        "Visitors are standing in front of you right now. Greet them immediately and compliment their costumes.",
      );
    }, this.nudgeMs);
  }

  protected teardown(reason: string): void {
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = null;
    super.teardown(reason);
  }

  async observe(image: string): Promise<void> {
    try {
      const seen = (await this.look(image, "background", { quiet: true })).text;
      if (seen === this.lastObservation) return;
      this.lastObservation = seen;
      this.append(
        "session.thinking.append",
        null,
        `[CAMERA] Background update, for reference only (don't respond to it or greet again): ${seen}`,
      );
    } catch (err) {
      this.emit({ type: "error", message: `vision: ${(err as Error).message}` });
    }
  }

  say(text: string): void {
    this.append(
      "session.instructions.append",
      null,
      `Immediately say the following to the visitors, in your character's voice and style, then continue normally: "${text}"`,
    );
  }

  setMicEnabled(enabled: boolean): void {
    super.setMicEnabled(enabled);
    if (this.status === "open") this.send({ type: enabled ? "session.input_audio.unmute" : "session.input_audio.mute", event_id: this.nextId("mic") });
  }

  isThinking(): boolean {
    return this.pendingVision > 0;
  }

  /** GPT-Live asked for help: take a fresh look and report back on that delegation. */
  private async handleDelegation(id: string): Promise<void> {
    this.emit({ type: "note", text: "taking a fresh look (delegation)" });
    const image = this.deps.capture();
    let content: string;
    if (!image) {
      content = "[CAMERA] Your eyes couldn't get a look just now. Ask the visitor to describe it.";
    } else {
      try {
        content = `[CAMERA] Fresh look: ${(await this.look(image, "delegation", { withTranscript: true })).text}`;
      } catch (err) {
        this.emit({ type: "error", message: `vision: ${(err as Error).message}` });
        content = "[CAMERA] Your eyes couldn't get a clear look just now. Ask the visitor to describe it.";
      }
    }
    this.lastObservation = content;
    this.append("session.commentary.append", id, content);
  }

  private append(type: string, delegationId: string | null, content: string): void {
    if (!this.send({ type, event_id: this.nextId("ctx"), delegation_id: delegationId, content })) {
      this.emit({ type: "error", message: `not connected; dropped ${type}` });
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${++this.eventSeq}`;
  }

  /** Sends session.close and waits (briefly) for final usage in session.closed. */
  protected async gracefulClose(): Promise<void> {
    this.setStatus("closing");
    const closed = new Promise<void>((resolve) => (this.onClosed = resolve));
    if (!this.send({ type: "session.close" })) return;
    await withTimeout(closed, 10000, "no session.closed").catch(() => undefined);
  }
}
