import type { ClientConfig } from "../shared/types.ts";
import { describeSource, docsBlurb, groupVoices, voiceCatalog, type VoiceInfo } from "../shared/voices.ts";
import { browserStorage } from "./evening.ts";
import type { Engine } from "./engines/types.ts";
import { loadPickedVoice, savePickedVoice, shortName, voiceStatus, voiceTags } from "./voiceChoice.ts";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * The dashboard's voice picker: every voice the engine can use, with what OpenAI's docs say about
 * it and our own notes. The pick is remembered (per engine) and sent with each new voice session;
 * the server only accepts voices on its allowlist.
 */
export class VoicePanel {
  private picked: string | null;
  private sessionVoice: string | null = null;
  private startingVoice: string | null = null;
  private engine: Engine | null = null;
  private visitorsPresent: () => boolean = () => false;
  private restarting = false;
  private readonly storage = browserStorage();
  private readonly summary = el("summary");
  private readonly body = el("div", "voice-body");

  constructor(
    private readonly container: HTMLElement,
    private readonly cfg: ClientConfig,
    private readonly log: (text: string) => void,
  ) {
    this.picked = loadPickedVoice(this.storage, cfg.engine);
    container.replaceChildren(this.summary, this.body);
    this.render();
  }

  private readonly pickListeners = new Set<(picked: string | null) => void>();

  /** For EngineDeps.voice: read as each session starts. Sends only the dashboard pick (or nothing). */
  readonly requestVoice = (): string | null => {
    this.startingVoice = this.status().effective.voice;
    return this.picked;
  };

  /** The dashboard's pick (null: the server's default), as /api/session and /api/clips take it. */
  get pickedVoice(): string | null {
    return this.picked;
  }

  /** Called with the new pick whenever the operator picks a voice (or goes back to the default). */
  onPick(listener: (picked: string | null) => void): void {
    this.pickListeners.add(listener);
  }

  /** Follows the engine to show which voice the running session has, and to offer a restart. */
  attach(engine: Engine, visitorsPresent: () => boolean): void {
    this.engine = engine;
    this.visitorsPresent = visitorsPresent;
    engine.on((e) => {
      if (e.type !== "status") return;
      if (e.status === "open") this.sessionVoice = this.startingVoice;
      if (e.status === "closed") this.sessionVoice = null;
      this.render();
    });
  }

  private status() {
    return voiceStatus(this.cfg, this.picked, this.sessionVoice);
  }

  private pick(id: string | null): void {
    this.picked = id;
    savePickedVoice(this.storage, this.cfg.engine, id);
    const status = this.status();
    this.log(`Voice: ${status.summary}. ${status.restartNeeded ? "Applies from the next voice session (or restart it now)." : "Applies from the next voice session."}`);
    this.render();
    for (const listener of this.pickListeners) listener(id);
  }

  /** Ends the session; the director reconnects (with the new voice) right away if visitors are there. */
  private async restart(): Promise<void> {
    if (!this.engine || this.restarting) return;
    this.restarting = true;
    this.render();
    const voice = this.status().effective.voice;
    this.log(`Restarting the voice session to switch to ${voice}`);
    try {
      await this.engine.close();
      this.log(this.visitorsPresent() ? `Reconnecting with ${voice}…` : `Voice session closed: ${voice} starts when the next visitor arrives`);
    } finally {
      this.restarting = false;
      this.render();
    }
  }

  private render(): void {
    const { cfg } = this;
    const status = this.status();
    const catalog = voiceCatalog(cfg.engine);
    const name = shortName(cfg.character.name);
    this.summary.textContent = `Voice: ${status.summary}`;

    const head = el("div", "voice-status");
    const current = el("p");
    current.append("Current: ", el("strong", undefined, status.effective.voice), ` (${describeSource(status.effective.source, name)})`);
    const order = el(
      "p",
      "hint",
      `Order: your pick here, then VOICE in .env (${cfg.voice.env ?? "not set"}), then ${name}'s default (${cfg.voice.character}).`,
    );
    head.append(current, order);
    if (status.envUnknown) head.append(el("p", "hint", `VOICE in .env (${cfg.voice.env}) isn't in this list; it's still used when nothing is picked here.`));

    const actions = el("div", "voice-actions");
    const useDefault = el("button", undefined, `Use default (${status.fallback.voice}, ${status.fallback.source === "env" ? "from .env" : `${name}'s`})`);
    useDefault.type = "button";
    useDefault.disabled = this.picked === null;
    useDefault.addEventListener("click", () => this.pick(null));
    actions.append(useDefault);
    if (status.restartNeeded) {
      const restart = el("button", "restart", this.restarting ? "Restarting…" : "🔄 Restart voice session now");
      restart.type = "button";
      restart.disabled = this.restarting;
      restart.addEventListener("click", () => void this.restart());
      actions.append(restart);
    }
    const applies = el("p", status.restartNeeded ? "applies pending" : "applies hint", status.applies);

    const source = el("p", "hint");
    const link = el("a", undefined, `OpenAI's docs ("${catalog.docsSection}")`);
    link.href = catalog.docsUrl;
    link.target = "_blank";
    link.rel = "noopener";
    source.append(
      `Voices for ${cfg.engine === "live" ? "GPT-Live" : "gpt-realtime"}. Descriptions are from `,
      link,
      `, checked ${catalog.checked}. ${cfg.engine === "live" ? "They give language, regional influence, presentation and source, not tone." : "They list the voice names and recommend two."} "Our notes" are from trying them.`,
    );

    const { english, undescribed, other } = groupVoices(catalog);
    const list = el("div", "voice-list");
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", "Voice");
    if (english.length) list.append(el("h3", undefined, "English voices"), ...english.map((v) => this.row(v, status, catalog.docsUrl)));
    if (undescribed.length) {
      const heading = english.length || other.length ? "Not in the docs' voice table" : "Voices";
      list.append(el("h3", undefined, heading), ...undescribed.map((v) => this.row(v, status, catalog.docsUrl)));
    }
    if (other.length) {
      list.append(
        el("h3", undefined, "Other languages"),
        el("p", "hint", "Our notes: these carry their language's accent, even when speaking English."),
        ...other.map((v) => this.row(v, status, catalog.docsUrl)),
      );
    }
    // Keep the list's scroll position and keyboard focus across re-renders.
    const scrollTop = this.body.querySelector<HTMLElement>(".voice-list")?.scrollTop ?? 0;
    const focused = document.activeElement instanceof HTMLInputElement && this.body.contains(document.activeElement) ? document.activeElement.value : null;
    this.body.replaceChildren(head, actions, applies, source, list);
    list.scrollTop = scrollTop;
    if (focused) list.querySelector<HTMLInputElement>(`input[value="${CSS.escape(focused)}"]`)?.focus();
  }

  private row(voice: VoiceInfo, status: ReturnType<VoicePanel["status"]>, docsUrl: string): HTMLElement {
    const row = el("label", "voice-row");
    if (status.effective.voice === voice.id) row.classList.add("current");
    const input = el("input");
    input.type = "radio";
    input.name = "voice";
    input.value = voice.id;
    input.checked = status.effective.voice === voice.id;
    input.addEventListener("change", () => this.pick(voice.id));
    const text = el("span", "voice-text");
    const title = el("span", "voice-name", voice.id);
    for (const tag of voiceTags(this.cfg, status, voice.id)) title.append(" ", el("span", `tag${tag === "current" ? " on" : ""}`, tag));
    const docs = el("span", "voice-docs");
    const link = el("a", undefined, "From OpenAI's docs");
    link.href = docsUrl;
    link.target = "_blank";
    link.rel = "noopener";
    docs.append(link, `: ${docsBlurb(voice) || "no description"}`);
    text.append(title, docs);
    if (voice.ourNotes) text.append(el("span", "voice-notes", `Our notes: ${voice.ourNotes}`));
    row.append(input, text);
    return row;
  }
}
