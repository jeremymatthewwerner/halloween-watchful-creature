import type { Engine } from "./engines/types.ts";
import { MODES, modeLabel, type ModeId } from "./modes.ts";
import { AUTO_HINT, DEFAULT_SPOOKINESS, SPOOKY_LEVELS, spookyInfo, type SpookyChoice, type SpookyLevel } from "./spookiness.ts";
import { OperatorStanding } from "./standing.ts";

const storage = (): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

/** How often to re-check the clock for the dial's "auto" setting. */
const AUTO_CHECK_MS = 30_000;

const DIAL: readonly { choice: SpookyChoice; label: string; title: string }[] = [
  ...SPOOKY_LEVELS.map((l) => ({ choice: l.level, label: l.label, title: l.rule || "The creature's normal, light spooky fun." })),
  { choice: "auto", label: "🕰️ Auto", title: `Follows the clock: ${AUTO_HINT}.` },
];

/**
 * The dashboard's quick-mode buttons and spookiness dial. Their state is remembered for the evening,
 * and works before the creature is awake: it's applied when the engine is attached.
 */
export class ModePanel {
  private readonly standing = new OperatorStanding(storage());
  private readonly buttons = new Map<ModeId, HTMLButtonElement>();
  private readonly dialButtons = new Map<SpookyChoice, HTMLButtonElement>();
  private readonly dialHint = document.createElement("span");

  constructor(
    container: HTMLElement,
    private readonly log: (text: string) => void,
  ) {
    for (const mode of MODES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mode";
      button.textContent = mode.label;
      button.title = mode.rule;
      button.addEventListener("click", () => this.toggle(mode.id));
      this.buttons.set(mode.id, button);
      container.append(button);
    }
    container.after(...this.buildDial());
    this.render();
    if (this.standing.active.length) this.log(`Quick modes still on from earlier tonight: ${this.describe()}`);
    if (this.standing.spookyChoice !== DEFAULT_SPOOKINESS) this.log(`Spookiness still set from earlier tonight: ${this.describeSpookiness()}`);
    setInterval(() => {
      if (this.standing.tick()) {
        this.render();
        this.log(`Spookiness auto: now ${this.describeSpookiness()}`);
      }
    }, AUTO_CHECK_MS);
  }

  /** The spookiness in use right now, 0 (gentle) to 3 (scary, for teens). For greetings and sound effects. */
  get spookiness(): SpookyLevel {
    return this.standing.spookiness;
  }

  /** Called whenever the spookiness in use changes. Returns an unsubscribe. */
  onSpookiness(listener: (level: SpookyLevel) => void): () => void {
    return this.standing.onSpookiness(listener);
  }

  /** Hands the standing instructions to the engine; it re-applies them to every new voice session. */
  attach(engine: Engine): void {
    this.standing.attach(engine);
  }

  private buildDial(): HTMLElement[] {
    const head = document.createElement("div");
    head.className = "modes-head";
    const title = document.createElement("h2");
    title.textContent = "Spookiness";
    this.dialHint.className = "hint";
    head.append(title, this.dialHint);
    const group = document.createElement("div");
    group.className = "modes spooky-dial";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Spookiness");
    for (const { choice, label, title: tip } of DIAL) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "level";
      button.setAttribute("role", "radio");
      button.textContent = label;
      button.title = tip;
      button.addEventListener("click", () => this.setSpookiness(choice));
      this.dialButtons.set(choice, button);
      group.append(button);
    }
    return [head, group];
  }

  /** Every mode with whether it's on (for the phone remote). */
  list(): { id: ModeId; label: string; on: boolean }[] {
    return MODES.map((m) => ({ id: m.id, label: m.label, on: this.standing.active.includes(m.id) }));
  }

  /** Turns a mode on or off (from the phone remote); same as tapping its button. */
  set(id: ModeId, on: boolean): void {
    if (this.standing.active.includes(id) !== on) this.toggle(id);
  }

  private toggle(id: ModeId): void {
    const before = this.standing.spookiness;
    const on = this.standing.toggleMode(id);
    this.render();
    this.log(`Quick mode ${on ? "on" : "off"}: ${modeLabel(id)} (now: ${this.describe()})`);
    if (this.standing.spookiness !== before) this.log(`Spookiness: ${this.describeSpookiness()}`);
  }

  private setSpookiness(choice: SpookyChoice): void {
    if (choice === this.standing.spookyChoice) return;
    this.standing.setSpookiness(choice);
    this.render();
    this.log(`Spookiness: ${this.describeSpookiness()}`);
  }

  private describe(): string {
    return this.standing.active.map(modeLabel).join(", ") || "normal";
  }

  private describeSpookiness(): string {
    const name = spookyInfo(this.standing.spookiness).name;
    const choice = this.standing.spookyChoice;
    const dial = choice === "auto" ? `auto, ${name} for now (${AUTO_HINT})` : spookyInfo(choice).name;
    return this.standing.active.includes("toddler") ? `gentle while Toddler mode is on (dial: ${dial})` : dial;
  }

  private render(): void {
    for (const [id, button] of this.buttons) {
      const on = this.standing.active.includes(id);
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
    for (const [choice, button] of this.dialButtons) {
      const picked = choice === this.standing.spookyChoice;
      button.classList.toggle("on", picked);
      button.setAttribute("aria-checked", String(picked));
    }
    const toddler = this.standing.active.includes("toddler");
    this.dialHint.textContent = toddler
      ? "Toddler mode is on, so it's gentle for now."
      : this.standing.spookyChoice === "auto"
        ? `Auto: ${AUTO_HINT}. Now: ${spookyInfo(this.standing.spookiness).name}.`
        : "Stays set tonight. The creature turns it down by itself if a little kid seems scared.";
  }
}
