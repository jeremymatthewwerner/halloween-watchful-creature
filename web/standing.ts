/**
 * Everything the family at the door has asked for tonight (the quick modes and the spookiness dial),
 * combined into the one set of standing instructions the voice engine keeps and re-sends to every
 * new session. Remembered for the evening. DOM-free, so the dashboard panel stays a thin view.
 */
import type { Engine } from "./engines/types.ts";
import { loadModes, modeInstructions, modeUpdate, saveModes, toggleMode, type ModeId, type Store } from "./modes.ts";
import {
  loadSpookiness,
  resolveSpookiness,
  saveSpookiness,
  spookyRules,
  type SpookyChoice,
  type SpookyLevel,
} from "./spookiness.ts";

/** The standing instructions for these modes at this spookiness, or "" for a normal evening. */
export const standingInstructions = (active: readonly ModeId[], level: SpookyLevel): string =>
  modeInstructions(active, spookyRules(level));

/** What to tell an open session after something changed. */
export const standingUpdate = (active: readonly ModeId[], level: SpookyLevel): string => modeUpdate(active, spookyRules(level));

export class OperatorStanding {
  private modes: ModeId[];
  private choice: SpookyChoice;
  private level: SpookyLevel;
  private engine: Pick<Engine, "setStanding"> | null = null;
  /** The standing instructions the engine last got, so unchanged ones aren't re-sent. */
  private sent: string | null = null;
  private readonly listeners = new Set<(level: SpookyLevel) => void>();

  constructor(
    private readonly store: Store | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.modes = loadModes(store, now());
    this.choice = loadSpookiness(store, now());
    this.level = resolveSpookiness(this.choice, this.modes, now());
  }

  get active(): readonly ModeId[] {
    return this.modes;
  }

  /** What the operator picked on the dial (a level or "auto"). */
  get spookyChoice(): SpookyChoice {
    return this.choice;
  }

  /** The spookiness the creature uses right now (after Toddler mode and the auto schedule). */
  get spookiness(): SpookyLevel {
    return this.level;
  }

  /** Called whenever the spookiness in use changes (for greetings, sound effects, ...). Returns an unsubscribe. */
  onSpookiness(listener: (level: SpookyLevel) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  instructions(): string {
    return standingInstructions(this.modes, this.level);
  }

  /** Hands the standing instructions to the engine; it re-applies them to every new voice session. */
  attach(engine: Pick<Engine, "setStanding">): void {
    this.engine = engine;
    this.sent = this.instructions();
    engine.setStanding(this.sent);
  }

  /** Turns a quick mode on or off. Returns whether it's now on. */
  toggleMode(id: ModeId, on = !this.modes.includes(id)): boolean {
    this.modes = toggleMode(this.modes, id, on);
    saveModes(this.store, this.modes, this.now());
    this.update();
    return on;
  }

  setSpookiness(choice: SpookyChoice): void {
    this.choice = choice;
    saveSpookiness(this.store, choice, this.now());
    this.update();
  }

  /** Re-checks the clock for "auto". Returns true if the spookiness in use changed. */
  tick(): boolean {
    const before = this.level;
    this.update();
    return this.level !== before;
  }

  private update(): void {
    const before = this.level;
    this.level = resolveSpookiness(this.choice, this.modes, this.now());
    const text = this.instructions();
    if (this.engine && text !== this.sent) {
      this.sent = text;
      this.engine.setStanding(text, standingUpdate(this.modes, this.level));
    }
    if (this.level !== before) for (const listener of this.listeners) listener(this.level);
  }
}
