import type { Engine } from "./engines/types.ts";
import { MODES, loadModes, modeInstructions, modeLabel, modeUpdate, saveModes, toggleMode, type ModeId } from "./modes.ts";

const storage = (): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

/**
 * The dashboard's quick-mode buttons. Their on/off state is remembered for the evening, and works
 * before the creature is awake: the modes are applied when the engine is attached.
 */
export class ModePanel {
  private active: ModeId[];
  private engine: Engine | null = null;
  private readonly buttons = new Map<ModeId, HTMLButtonElement>();

  constructor(
    container: HTMLElement,
    private readonly log: (text: string) => void,
  ) {
    this.active = loadModes(storage());
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
    this.render();
    if (this.active.length) this.log(`Quick modes still on from earlier tonight: ${this.describe()}`);
  }

  /** Hands the current modes to the engine; it re-applies them to every new voice session. */
  attach(engine: Engine): void {
    this.engine = engine;
    engine.setStanding(modeInstructions(this.active));
  }

  /** Every mode with whether it's on (for the phone remote). */
  list(): { id: ModeId; label: string; on: boolean }[] {
    return MODES.map((m) => ({ id: m.id, label: m.label, on: this.active.includes(m.id) }));
  }

  /** Turns a mode on or off (from the phone remote); same as tapping its button. */
  set(id: ModeId, on: boolean): void {
    if (this.active.includes(id) !== on) this.toggle(id);
  }

  private toggle(id: ModeId): void {
    const on = !this.active.includes(id);
    this.active = toggleMode(this.active, id, on);
    saveModes(storage(), this.active);
    this.render();
    this.engine?.setStanding(modeInstructions(this.active), modeUpdate(this.active));
    this.log(`Quick mode ${on ? "on" : "off"}: ${modeLabel(id)} (now: ${this.describe()})`);
  }

  private describe(): string {
    return this.active.map(modeLabel).join(", ") || "normal";
  }

  private render(): void {
    for (const [id, button] of this.buttons) {
      const on = this.active.includes(id);
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
  }
}
