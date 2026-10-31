import { bigGroupNote, bigGroupPlan, groupSize, isBigGroup } from "../bigGroup.ts";
import { UNSURE_RETURN, WebRtcEngine, operatorLine, withTimeout } from "./base.ts";
import type { Engine, GreetOptions, GreetReason } from "./types.ts";
import { Variety } from "./variety.ts";

type ServerEvent = { type: string; [key: string]: unknown };

/** The vision model names each costume's standout detail ("standout: ..."); make the compliment about it. */
const PRAISE_DETAIL = " Make the compliment specific: praise each costume's standout detail in your own words (for a big group, just a few).";

const GREETING: Record<GreetReason, (seen: string) => string> = {
  arrived: (seen) => `[CAMERA] New visitors just walked up to you. What you see: ${seen} Greet them now and compliment their costumes.${PRAISE_DETAIL}`,
  grew: (seen) => `[CAMERA] More visitors just joined the group. What you see now: ${seen} Welcome the newcomers and compliment their costumes.${PRAISE_DETAIL}`,
  manual: (seen) => `[CAMERA] What you see right now: ${seen} Greet whoever is there and compliment their costumes.${PRAISE_DETAIL}`,
  // "returned" is resolved to "arrived" (new visitors) or a welcome-back before speaking.
  returned: (seen) => `[CAMERA] New visitors just walked up to you. What you see: ${seen} Greet them now and compliment their costumes.${PRAISE_DETAIL}`,
};

/**
 * Said while the vision model is still looking (it takes a couple of seconds), so visitors hear
 * something right away. Not for "returned": the same people back soon should get silence.
 */
const QUICK_HELLO: Partial<Record<GreetReason, string>> = {
  arrived:
    "[CAMERA] Visitors just walked up to you. Your eyes are still focusing on their costumes: right now, give them a quick, " +
    "warm hello in character (one short line). Don't describe or guess their costumes yet.",
  manual:
    "[CAMERA] Someone is in front of you. Your eyes are still focusing: right now, give them a quick, warm hello in character " +
    "(one short line). Don't describe or guess their costumes yet.",
  grew:
    "[CAMERA] More visitors just joined the group. Your eyes are still focusing on them: give the newcomers a quick hello in " +
    "character (one short line). Don't describe or guess their costumes yet.",
};

/** After a quick hello: the costume details, once the vision model has them. */
const FOLLOW_UP: Partial<Record<GreetReason, (seen: string) => string>> = {
  arrived: (seen) => `[CAMERA] Your eyes have focused. What you see: ${seen} Now compliment their costumes.${PRAISE_DETAIL}`,
  manual: (seen) => `[CAMERA] Your eyes have focused. What you see: ${seen} Now compliment their costumes.${PRAISE_DETAIL}`,
  grew: (seen) => `[CAMERA] Your eyes have focused on the group. What you see now: ${seen} Now compliment the newcomers' costumes.${PRAISE_DETAIL}`,
};

/**
 * Big groups (web/bigGroup.ts): one quick group welcome, a shout-out to one or two standout costumes and
 * one fun group moment, instead of going costume by costume while kids wait for candy.
 */
const BIG_GREETING: Record<GreetReason, (seen: string, size: number) => string> = {
  arrived: (seen, n) => `[CAMERA] A big group just walked up to you (about ${n} people). What you see: ${seen} ${bigGroupPlan()}`,
  grew: (seen, n) => `[CAMERA] More visitors just joined, and it's a big group now (about ${n} people). What you see now: ${seen} ${bigGroupPlan(true)}`,
  manual: (seen, n) => `[CAMERA] A big group is in front of you (about ${n} people). What you see right now: ${seen} ${bigGroupPlan()}`,
  returned: (seen, n) => `[CAMERA] A big group just walked up to you (about ${n} people). What you see: ${seen} ${bigGroupPlan()}`,
};

const BIG_QUICK_HELLO: Partial<Record<GreetReason, (size: number) => string>> = {
  arrived: (n) =>
    `[CAMERA] A big group just walked up to you (about ${n} people). Your eyes are still focusing on their costumes: right now, ` +
    "give the whole group one quick, warm welcome in character (one short line). Don't describe or guess their costumes yet.",
  manual: (n) =>
    `[CAMERA] A big group is in front of you (about ${n} people). Your eyes are still focusing: right now, give the whole group ` +
    "one quick, warm welcome in character (one short line). Don't describe or guess their costumes yet.",
  grew: (n) =>
    `[CAMERA] More visitors just joined, and it's a big group now (about ${n} people). Your eyes are still focusing on them: give ` +
    "the newcomers one quick group hello in character (one short line). Don't describe or guess their costumes yet.",
};

const BIG_FOLLOW_UP = (seen: string, newcomers: boolean): string =>
  `[CAMERA] Your eyes have focused. What you see: ${seen} Now shout out one or two standout costumes${newcomers ? " among the newcomers" : ""}, ` +
  "not costume by costume, then one fun group moment. Don't start a mini-game with this group.";

/** Wait this long for the vision model before saying a quick hello. */
const HELLO_AFTER_MS = 250;

/** Firmer follow-ups when a greeting request didn't make the creature start talking. */
const NUDGE = {
  greet: "Visitors are standing in front of you right now. Greet them immediately and compliment their costumes.",
  grew: "New visitors just joined the group and you haven't welcomed them yet. Welcome the newcomers now and compliment their costumes.",
  newcomer: "Someone new is standing in front of you and you haven't greeted them yet. Greet them now and compliment their costumes.",
  compliment: "You haven't complimented the visitors' costumes yet. Do it now.",
  group: "A big group of visitors is waiting in front of you right now. Give them one quick group welcome now and shout out one or two standout costumes.",
};

/** Speech after at least this much quiet counts as a new utterance. */
const QUIET_MS = 700;

/**
 * Remark on a costume change spotted by a background look (a hat tipped back mid-chat) at most this
 * often. A change found after a gap (someone stepped out and back in) is deliberate: always remarked.
 */
const CHANGE_REMARK_EVERY_MS = 30_000;

/** A "grew" this soon after a same/new check greeted the newcomers isn't greeted again. */
const NEWCOMER_GREETED_MS = 20_000;

/** Same visitors back after at least this long get a quick "welcome back"; sooner, silence. */
const WELCOME_BACK_AFTER_MS = 45_000;

/**
 * GPT-Live engine (gpt-live-1) using client delegation. GPT-Live can't take images,
 * so camera frames go to the server's vision backend and come back as text:
 *  - greetings     → session.commentary.append (spoken, paraphrased in character)
 *  - background    → session.thinking.append (known, not spoken)
 *  - operator lines ("Make it say…") → session.commentary.append (spoken now)
 *  - operator modes → session.instructions.append (standing; steers later turns)
 *  - delegations   → a fresh look, returned with the delegation's id
 */
export class LiveEngine extends WebRtcEngine implements Engine {
  readonly kind = "live" as const;
  private onStarted: (() => void) | null = null;
  private onClosed: (() => void) | null = null;
  private lastObservation = "";
  /** How the current/most recent group was described when greeted, and the frame it was greeted from. */
  private lastGroup = "";
  private lastGroupImage: string | undefined;
  /** When a same/new check last found and greeted someone new. */
  private lastNewcomerAt = -Infinity;
  /** When the creature last remarked on a costume change. */
  private lastChangeRemarkAt = -Infinity;
  private eventSeq = 0;
  private lastSpokeAt = 0;
  /** When the creature's current (or latest) transcribed utterance began. */
  private utteranceStartedAt = 0;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Picks a different style twist for each greeting, so the creature doesn't repeat itself. */
  protected variety = new Variety(Math.random, () => this.deps.spookiness?.() ?? 1);
  private nudgePoll: ReturnType<typeof setInterval> | null = null;
  /** If a greeting hasn't started this long after we asked, nudge with an instruction. */
  protected nudgeMs = 5000;
  /** Operator modes, re-applied to each new session (sessions restart often). */
  private standing = "";

  protected waitUntilReady(): Promise<void> {
    return new Promise((resolve) => (this.onStarted = resolve));
  }

  protected onServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case "session.started":
        this.lastObservation = "";
        this.lastGroup = "";
        this.lastGroupImage = undefined;
        this.onStarted?.();
        this.onStarted = null;
        // Apply the director's mic gating to the new session as well as the local track.
        this.send({ type: this.micEnabled ? "session.input_audio.unmute" : "session.input_audio.mute", event_id: this.nextId("mic") });
        this.remindOfTonight();
        if (this.standing) {
          this.append("session.instructions.append", null, this.standing);
          this.emit({ type: "note", text: "operator modes re-applied to the new session" });
        }
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
      case "session.output_transcript.delta": {
        const now = Date.now();
        if (now - this.lastSpokeAt >= QUIET_MS) this.utteranceStartedAt = now;
        this.lastSpokeAt = now;
        this.emit({ type: "transcript", who: "creature", delta: String(event.delta ?? "") });
        break;
      }
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

  async greet(image: string | null, reason: GreetReason, opts: GreetOptions = {}): Promise<void> {
    // Compare a return with the last group only if this session greeted them: a new session doesn't remember.
    const previous = reason === "returned" && this.status === "open" && this.lastGroup ? this.lastGroup : undefined;
    const alreadyGreeted = reason === "grew" && Date.now() - this.lastNewcomerAt < NEWCOMER_GREETED_MS;
    // Start looking right away: the vision call runs while the session finishes connecting.
    const looking = image
      ? this.look(image, reason, { previous, previousImage: previous ? this.lastGroupImage : undefined }).then(
          (result) => ({ result }),
          (error: Error) => ({ error }),
        )
      : null;
    if (opts.ready && !(await opts.ready)) return;

    // A big group (or a line forming) by the tracker's count; the vision description may raise it below.
    const counted = opts.count ?? 0;
    let notedBig = false;
    const noteBig = (size: number) => {
      if (!notedBig) this.emit({ type: "note", text: bigGroupNote(size, opts.grows) });
      notedBig = true;
    };

    // Vision takes a couple of seconds: say hello first instead of standing there silent.
    const bigHello = isBigGroup(counted, opts.grows) ? BIG_QUICK_HELLO[reason] : undefined;
    const hello = bigHello ? bigHello(counted) : QUICK_HELLO[reason];
    let saidHello = false;
    if (looking && hello && !alreadyGreeted && !(await settlesWithin(looking, HELLO_AFTER_MS))) {
      if (bigHello) noteBig(counted);
      this.append("session.commentary.append", null, hello + (bigHello ? this.variety.groupOpening() : this.variety.opening()));
      this.emit({ type: "greeting", kind: "visitors" });
      this.scheduleNudge(bigHello ? NUDGE.group : reason === "grew" ? NUDGE.grew : NUDGE.greet);
      saidHello = true;
    }

    let seen = "Your eyes aren't working right now, so you can't see their costumes; ask what they're dressed as.";
    let sameGroup = false;
    let looked = false;
    if (looking) {
      const outcome = await looking;
      if ("result" in outcome) {
        seen = outcome.result.text;
        sameGroup = Boolean(previous) && outcome.result.sameGroup === true;
        looked = true;
      } else {
        this.emit({ type: "error", message: `vision: ${outcome.error.message}` });
        seen = "It's too hard to see their costumes right now; ask what they're dressed as.";
      }
    }
    this.lastObservation = seen;
    if (reason === "returned") {
      if (!looked && previous) {
        // Keep lastGroup: the next return that gets a clear look still compares with them.
        this.emit({ type: "note", text: "couldn't check whether these are the same visitors (no clear look): asking them" });
        this.append("session.commentary.append", null, UNSURE_RETURN);
        this.emit({ type: "greeting", kind: "visitors" });
        this.scheduleNudge(NUDGE.greet);
        return;
      }
      if (sameGroup) {
        this.emit({ type: "note", text: `same visitors as before (vision saw: ${seen})` });
        if ((opts.awayMs ?? 0) >= WELCOME_BACK_AFTER_MS) {
          this.append("session.commentary.append", null, `[CAMERA] The same visitors you were talking to are back: ${seen} Give them a quick, fun "welcome back".`);
          this.emit({ type: "greeting", kind: "welcome-back" });
        } else {
          this.append("session.thinking.append", null, `[CAMERA] Background update, for reference only (don't greet again): ${seen}`);
        }
        return;
      }
      this.emit({ type: "note", text: `new visitors (vision saw: ${seen})` });
    }
    if (alreadyGreeted) {
      // A same/new check already greeted them: just keep the group's description current.
      this.emit({ type: "note", text: "the newcomers were already greeted" });
      this.lastGroup = seen;
      if (image) this.lastGroupImage = image;
      this.append("session.thinking.append", null, `[CAMERA] Background update, for reference only (don't greet again): ${seen}`);
      return;
    }
    // A manual greeting may be the same people again: it isn't counted as a new group.
    const tonight = reason === "manual" ? "" : this.countGroup(looked ? seen : null, reason === "grew" ? this.lastGroup : "");
    if (reason !== "grew") this.lastGroup = seen;
    else this.lastGroup = `${this.lastGroup} ${seen}`.trim();
    if (image) this.lastGroupImage = image;
    const followUp = FOLLOW_UP[reason];
    const size = groupSize(counted, looked ? seen : null);
    if (isBigGroup(size, opts.grows)) {
      noteBig(size);
      this.append(
        "session.commentary.append",
        null,
        (saidHello ? BIG_FOLLOW_UP(seen, reason === "grew") + this.variety.groupFinish() : BIG_GREETING[reason](seen, size) + this.variety.groupGreeting()) +
          tonight,
      );
      if (!saidHello) this.emit({ type: "greeting", kind: "visitors" });
      this.scheduleNudge(NUDGE.group);
      return;
    }
    this.append(
      "session.commentary.append",
      null,
      (saidHello && followUp ? followUp(seen) + this.variety.verdict() : GREETING[reason](seen) + this.variety.greeting()) + tonight,
    );
    if (!saidHello) this.emit({ type: "greeting", kind: "visitors" });
    this.scheduleNudge(reason === "grew" ? NUDGE.grew : saidHello ? NUDGE.compliment : NUDGE.greet);
  }

  /**
   * Counts a newly greeted group for tonight's running gags; returns the optional fun facts for its
   * greeting. `previous`: the group's description before it grew, so costumes aren't counted twice.
   */
  private countGroup(seen: string | null, previous = ""): string {
    const evening = this.deps.evening;
    if (!evening) return "";
    evening.recordGroup(seen, previous);
    return evening.tonightContext(seen) ?? "";
  }

  /** A new session remembers nothing: tell it, in the background, what it already said tonight. */
  private remindOfTonight(): void {
    const evening = this.deps.evening;
    const memory = evening?.memoryContext();
    if (!evening || !memory) return;
    this.append("session.thinking.append", null, memory);
    const { said, groups } = evening.current;
    this.emit({ type: "note", text: `reminded the new session of tonight (${said.length} lines said, ${groups} groups greeted)` });
  }

  /**
   * GPT-Live's docs say appended context "may" be spoken, not that it will be.
   * If the creature doesn't start a new utterance after a greeting request, ask more firmly, once.
   * The tail of a reply that was already under way when we asked doesn't count.
   */
  private scheduleNudge(instruction: string): void {
    const sentAt = Date.now();
    this.clearNudge();
    let quietSeen = !this.talking();
    let startedNew = false;
    this.nudgePoll = setInterval(() => {
      if (!this.talking()) quietSeen = true;
      else if (quietSeen) startedNew = true;
    }, 150);
    this.nudgeTimer = setTimeout(() => {
      this.clearNudge();
      if (this.status !== "open" || startedNew || this.utteranceStartedAt > sentAt) return;
      this.emit({ type: "note", text: "greeting didn't start; nudging" });
      this.append("session.instructions.append", null, instruction);
    }, this.nudgeMs);
  }

  /** Whether the creature is audible or its transcript is streaming (transcripts can lag or be missing). */
  private talking(): boolean {
    return performance.now() - this.deps.lastVoiceAt() < QUIET_MS || Date.now() - this.lastSpokeAt < QUIET_MS;
  }

  private clearNudge(): void {
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    if (this.nudgePoll) clearInterval(this.nudgePoll);
    this.nudgeTimer = this.nudgePoll = null;
  }

  protected teardown(reason: string): void {
    this.clearNudge();
    super.teardown(reason);
  }

  async observe(image: string): Promise<void> {
    await this.checkForNewcomers(image, "background");
  }

  async recheck(image: string): Promise<void> {
    await this.checkForNewcomers(image, "recheck");
  }

  /**
   * A look while visitors are present. With a greeted group to compare against, the vision model
   * also says whether someone new has stepped in (a swap the tracker can't see); if so, greet them.
   */
  private async checkForNewcomers(image: string, reason: "background" | "recheck"): Promise<void> {
    try {
      const previous = this.lastGroup || undefined;
      const result = await this.look(image, reason, {
        quiet: reason === "background",
        previous,
        previousImage: previous ? this.lastGroupImage : undefined,
      });
      const seen = result.text;
      if (previous && result.sameGroup === false) {
        this.emit({ type: "note", text: `someone new is here (vision saw: ${seen})` });
        const tonight = this.countGroup(seen, previous);
        this.lastObservation = this.lastGroup = seen;
        this.lastGroupImage = image;
        this.lastNewcomerAt = Date.now();
        this.append(
          "session.commentary.append",
          null,
          `[CAMERA] Someone new is in front of you who you haven't greeted yet. What you see now: ${seen} Greet them now and compliment their costumes.` +
            this.variety.greeting() +
            tonight,
        );
        this.emit({ type: "greeting", kind: "visitors" });
        this.scheduleNudge(NUDGE.newcomer);
        return;
      }
      if (previous && result.verdict === "CHANGED") {
        // Same people, new look: compare with the new look from now on, so it's only remarked on once.
        this.lastObservation = this.lastGroup = seen;
        this.lastGroupImage = image;
        if (reason === "recheck" || Date.now() - this.lastChangeRemarkAt >= CHANGE_REMARK_EVERY_MS) {
          this.lastChangeRemarkAt = Date.now();
          this.emit({ type: "note", text: `costume change (vision saw: ${seen})` });
          this.append(
            "session.commentary.append",
            null,
            `[CAMERA] The visitors you're talking to just changed their look. What you see now: ${seen} Make one quick, playful remark about the change. Don't greet them again.`,
          );
          this.emit({ type: "greeting", kind: "costume" });
        } else {
          this.emit({ type: "note", text: `costume change, but remarked on one recently (vision saw: ${seen})` });
          this.append("session.thinking.append", null, `[CAMERA] Background update, for reference only (don't respond to it or greet again): ${seen}`);
        }
        return;
      }
      if (reason === "recheck") this.emit({ type: "note", text: `no one new (vision saw: ${seen})` });
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

  /** An operator line: commentary, like a greeting, so it's spoken now (an instruction would only steer later turns). */
  say(text: string, opts: { nobodyHere?: boolean } = {}): void {
    this.append("session.commentary.append", null, operatorLine(text, !!opts.nobodyHere));
  }

  setStanding(standing: string, change?: string): void {
    this.standing = standing;
    if (change && this.status === "open") this.append("session.instructions.append", null, change);
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

/** Whether `promise` settles within `ms`; never waits longer than that. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
