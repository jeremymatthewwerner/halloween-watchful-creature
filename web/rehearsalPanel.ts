/**
 * The Rehearsal panel (under Settings) and the on-video banner. All the logic is in rehearsal.ts;
 * this only builds the DOM, loads sample images and calls it.
 */
import { galleryItems } from "../server/gallery.ts";
import type { GenerateVisitorsResult, GeneratedVisitor, GeneratedVisitorList } from "../shared/types.ts";
import { describeGenerated, generatedImage, generationCostText, logDays, type Rehearsal, type RehearsalAction, type RehearsalImage, type RehearsalSnapshot } from "./rehearsal.ts";
import "./rehearsal.css";

/** Same size and quality as Camera.capture(), so vision sees what it would from the webcam. */
const MAX_WIDTH = 768;
const QUALITY = 0.7;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Any image (file or blob) as a downscaled JPEG data URL. */
async function toFrame(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const canvas = el("canvas", { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", QUALITY);
}

export class RehearsalPanel {
  private readonly banner: HTMLDivElement;
  private readonly frame: HTMLImageElement;
  private readonly toggle: HTMLInputElement;
  private readonly thumbs: HTMLDivElement;
  private readonly status: HTMLParagraphElement;
  private readonly daySelect: HTMLSelectElement;
  private readonly logThumbs: HTMLDivElement;
  private readonly buttons = new Map<RehearsalAction | "script" | "stop", HTMLButtonElement>();
  private readonly genCount: HTMLInputElement;
  private readonly genGroup: HTMLSelectElement;
  private readonly genButton: HTMLButtonElement;
  private readonly genCost: HTMLSpanElement;
  private readonly genStatus: HTMLParagraphElement;
  private readonly genThumbs: HTMLDivElement;
  private genInfo: GeneratedVisitorList | null = null;
  private generating = false;

  constructor(
    container: HTMLElement,
    videoWrap: HTMLElement,
    private readonly rehearsal: Rehearsal,
    private readonly log: (text: string) => void,
  ) {
    this.frame = el("img", { className: "rehearsal-frame", alt: "Rehearsal sample image", hidden: true });
    this.banner = el("div", { className: "rehearsal-banner", hidden: true, textContent: "REHEARSAL — not the real camera" });
    videoWrap.append(this.frame, this.banner);
    // The frame sits under the person-box overlay so the pretend visitors' boxes show on it.
    videoWrap.querySelector("canvas")?.before(this.frame);

    this.toggle = el("input", { type: "checkbox" });
    this.toggle.addEventListener("change", () => (this.toggle.checked ? rehearsal.start() : rehearsal.stop()));

    const upload = el("input", { type: "file", accept: "image/*", multiple: true });
    upload.addEventListener("change", () => {
      void this.addFiles([...(upload.files ?? [])]);
      upload.value = "";
    });

    this.daySelect = el("select");
    this.daySelect.addEventListener("change", () => void this.showLogSnapshots());
    this.logThumbs = el("div", { className: "rehearsal-thumbs" });
    this.thumbs = el("div", { className: "rehearsal-thumbs" });
    this.status = el("p", { className: "hint" });

    this.genCount = el("input", { type: "number", min: "1", max: "6", value: "3", className: "gen-count" });
    this.genGroup = el("select", {}, new Option("random group sizes", ""), ...[1, 2, 3, 4].map((n) => new Option(`groups of ${n}`, String(n))));
    this.genCost = el("span", { className: "hint" });
    this.genButton = el("button", { type: "button", textContent: "✨ Generate visitors" });
    this.genStatus = el("p", { className: "hint" });
    this.genThumbs = el("div", { className: "rehearsal-thumbs generated" });
    this.genCount.addEventListener("input", () => this.renderGenerate());
    this.genButton.addEventListener("click", () => void this.generate());

    const button = (key: RehearsalAction | "script" | "stop", label: string, onClick: () => void) => {
      const b = el("button", { type: "button", textContent: label });
      b.addEventListener("click", onClick);
      this.buttons.set(key, b);
      return b;
    };
    const act = (action: RehearsalAction) => () => {
      const problem = rehearsal.act(action);
      if (problem) this.log(`Rehearsal: ${problem}`);
    };

    container.append(
      el(
        "details",
        { className: "rehearsal" },
        el("summary", {}, "🎭 Rehearsal (developer)"),
        el(
          "p",
          { className: "warn" },
          "Pretend visitors from sample images, without walking into frame. It uses the real voice and vision APIs, so it costs money just like real visitors.",
        ),
        el("label", { className: "rehearsal-toggle" }, this.toggle, " Rehearsal on (ignore the real camera)"),
        el("h3", {}, "Sample images"),
        el("label", {}, "Upload ", upload),
        el("p", { className: "hint" }, "Uploads stay in this page's memory: they're never saved or sent anywhere except to vision."),
        el("label", {}, "Or pick greeting snapshots from ", this.daySelect),
        this.logThumbs,
        el("h3", {}, "Generated visitors"),
        el("div", { className: "gen-row" }, el("label", {}, this.genCount, " images, "), this.genGroup, this.genButton, this.genCost),
        el(
          "p",
          { className: "hint" },
          "Made-up trick-or-treaters drawn by OpenAI's image model (cartoon style, not photos of real people), saved in rehearsal-cache/ so each is paid for once. " +
            "Click one to add it; its group size sets how many pretend people the tracker sees.",
        ),
        this.genStatus,
        this.genThumbs,
        el("h3", {}, "Chosen (click one to make it the camera frame)"),
        this.thumbs,
        el(
          "div",
          { className: "buttons" },
          button("arrive", "🚶 Visitor arrives", act("arrive")),
          button("leave", "👋 Leaves", act("leave")),
          button("swap", "🔁 Swap to next image", act("swap")),
          button("join", "👯 More visitors join", act("join")),
          button("script", "▶️ Run script", () => void rehearsal.runScript()),
          button("stop", "⏹ Stop script", () => rehearsal.stopScript()),
        ),
        this.status,
        el(
          "p",
          { className: "hint" },
          "Wake the creature first: pretend visitors are only noticed once it's awake. Timings are the real tracker's: a greeting starts about 1 s after arriving; “left” counts after 8 s out of view; " +
            "a swap steps out for 3 s (a gap, so it checks for someone new or a costume change; at most once per 10 s); " +
            "a joiner is greeted only once 30 s have passed since the last greeting. " +
            "With generated images, the person count is the picture's group size: “arrives” brings the whole group, a swap can change the group size, and “more visitors join” switches to the next bigger group. " +
            "The script: arrive, 20 s, swap, 10 s, leave, 15 s, come back. " +
            "Rehearsal lines are marked [REHEARSAL] in the log, no snapshots are saved and the gallery skips them.",
        ),
      ),
    );

    rehearsal.onChange((s) => this.render(s));
    this.render(rehearsal.snapshot());
  }

  /** Fills the day picker from the log list, newest first, and shows the newest day's snapshots. */
  async loadDays(): Promise<void> {
    try {
      const res = await fetch("/api/session-logs");
      const days = res.ok ? logDays(await res.text()) : [];
      this.daySelect.replaceChildren(...(days.length ? days.map((d) => new Option(d, d)) : [new Option("no logs yet", "")]));
      await this.showLogSnapshots();
    } catch {
      this.daySelect.replaceChildren(new Option("logs unavailable", ""));
    }
  }

  /** Loads the cached generated visitors and the cost estimate. */
  async loadGenerated(): Promise<void> {
    try {
      const res = await fetch("/api/rehearsal/generated");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.genInfo = (await res.json()) as GeneratedVisitorList;
    } catch (err) {
      this.genInfo = null;
      this.genStatus.textContent = `Couldn't load generated visitors (${(err as Error).message}).`;
    }
    this.renderGenerate();
  }

  private wantedCount(): number {
    const max = this.genInfo?.maxPerRequest ?? 6;
    return Math.min(max, Math.max(1, Math.round(Number(this.genCount.value) || 1)));
  }

  private renderGenerate(): void {
    const info = this.genInfo;
    this.genCount.max = String(info?.maxPerRequest ?? 6);
    this.genButton.disabled = this.generating || !info?.hasApiKey;
    this.genCost.textContent = info
      ? info.hasApiKey
        ? generationCostText(this.wantedCount(), info.estimate)
        : "needs OPENAI_API_KEY on the server (and REHEARSAL_CACHE_DIR not none)"
      : "";
    const items = info?.items ?? [];
    this.genThumbs.replaceChildren(
      ...items.map((item) => {
        const remove = el("button", { type: "button", className: "remove", textContent: "×", title: "Delete from the cache" });
        remove.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.deleteGenerated(item);
        });
        const label = describeGenerated(item);
        const img = el("img", { src: `/api/rehearsal/generated/${item.id}.jpg`, alt: label, loading: "lazy" });
        const card = el("div", { className: "thumb", title: `${label} (click to add)` }, img, el("span", { className: "badge", textContent: `👥${item.groupSize}` }), remove);
        card.addEventListener("click", () => void this.addGenerated(item));
        return card;
      }),
    );
    if (!items.length) this.genThumbs.append(el("span", { className: "hint", textContent: "None cached yet." }));
    if (!this.generating && info) {
      const spent = items.reduce((sum, i) => sum + i.costUsd, 0);
      this.genStatus.textContent = items.length ? `${items.length} cached (about $${spent.toFixed(2)} spent on them; reusing them is free).` : "";
    }
  }

  /** One image per request, so each shows up as soon as it's done and a failure doesn't lose the rest. */
  private async generate(): Promise<void> {
    if (this.generating || !this.genInfo) return;
    const count = this.wantedCount();
    const groupSize = this.genGroup.value ? Number(this.genGroup.value) : undefined;
    this.generating = true;
    this.renderGenerate();
    let made = 0;
    try {
      for (let i = 0; i < count; i++) {
        this.genStatus.textContent = `Generating ${i + 1} of ${count}… (each takes a little while)`;
        const res = await fetch("/api/rehearsal/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ count: 1, ...(groupSize && { groupSize }) }),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<GenerateVisitorsResult> & { error?: string };
        for (const e of data.errors ?? []) this.log(`Rehearsal: couldn't generate ${e}`);
        if (data.error) this.log(`Rehearsal: couldn't generate (${data.error})`);
        made += data.items?.length ?? 0;
        if (data.items?.length && this.genInfo) {
          this.genInfo.items = [...data.items, ...this.genInfo.items];
          this.renderGenerate();
        }
        // A bad request, a missing key or a busy server won't get better by trying the next one.
        if (!res.ok && res.status !== 502) break;
      }
    } catch (err) {
      this.log(`Rehearsal: couldn't generate (${(err as Error).message})`);
    } finally {
      this.generating = false;
      await this.loadGenerated();
      const summary = made < count ? `Generated ${made} of ${count} (the log says why).` : `Generated ${made}.`;
      this.genStatus.textContent = `${summary} ${this.genStatus.textContent}`;
    }
  }

  private async addGenerated(item: GeneratedVisitor): Promise<void> {
    try {
      const res = await fetch(`/api/rehearsal/generated/${item.id}.jpg`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.rehearsal.addImages([generatedImage(item, await toFrame(await res.blob()))]);
    } catch (err) {
      this.log(`Rehearsal: couldn't load that generated visitor (${(err as Error).message})`);
    }
  }

  private async deleteGenerated(item: GeneratedVisitor): Promise<void> {
    if (!window.confirm(`Delete this generated visitor (${describeGenerated(item)}) from the cache? Making another costs money.`)) return;
    const res = await fetch(`/api/rehearsal/generated/${item.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) this.log("Rehearsal: couldn't delete that generated visitor");
    await this.loadGenerated();
  }

  private async showLogSnapshots(): Promise<void> {
    const day = this.daySelect.value;
    this.logThumbs.replaceChildren();
    if (!day) return;
    const res = await fetch(`/api/session-logs/${day}/log.txt`).catch(() => null);
    const items = res?.ok ? galleryItems(await res.text()) : [];
    if (!items.length) {
      this.logThumbs.append(el("span", { className: "hint", textContent: "No snapshots on this day." }));
      return;
    }
    for (const item of items) {
      const url = `/api/session-logs/${day}/${item.file}`;
      const img = el("img", { src: url, alt: item.caption, title: `${item.time} ${item.label}: ${item.caption} (click to add)`, loading: "lazy" });
      img.addEventListener("click", () => void this.addFromLog(url, `${day} ${item.time} ${item.label}`));
      this.logThumbs.append(img);
    }
  }

  private async addFiles(files: File[]): Promise<void> {
    const images: RehearsalImage[] = [];
    for (const file of files) {
      try {
        images.push({ name: file.name, dataUrl: await toFrame(file), source: "upload" });
      } catch {
        this.log(`Rehearsal: couldn't read ${file.name} as an image`);
      }
    }
    this.rehearsal.addImages(images);
  }

  private async addFromLog(url: string, name: string): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.rehearsal.addImages([{ name, dataUrl: await toFrame(await res.blob()), source: "log" }]);
    } catch (err) {
      this.log(`Rehearsal: couldn't load that snapshot (${(err as Error).message})`);
    }
  }

  private render(s: RehearsalSnapshot): void {
    this.toggle.checked = s.active;
    this.banner.hidden = !s.active;
    document.body.classList.toggle("rehearsing", s.active);
    // Show what vision would see: the sample image while a pretend visitor is in view.
    const visible = s.active && s.people > 0 && !s.steppedOut && s.image;
    this.frame.hidden = !visible;
    if (visible && this.frame.src !== s.image!.dataUrl) this.frame.src = s.image!.dataUrl;

    const list = this.rehearsal.imageList;
    if (this.thumbs.childElementCount !== list.length || [...this.thumbs.children].some((c, i) => (c as HTMLElement).dataset.name !== list[i]?.name)) {
      this.thumbs.replaceChildren(
        ...list.map((image, i) => {
          const remove = el("button", { type: "button", className: "remove", textContent: "×", title: "Remove" });
          remove.addEventListener("click", (e) => {
            e.stopPropagation();
            this.rehearsal.removeImage(i);
          });
          const card = el("div", { className: "thumb", title: image.name }, el("img", { src: image.dataUrl, alt: image.name }), remove);
          card.dataset.name = image.name;
          card.addEventListener("click", () => this.rehearsal.select(i));
          return card;
        }),
      );
    }
    [...this.thumbs.children].forEach((c, i) => c.classList.toggle("current", i === s.index));
    if (!list.length) this.thumbs.append(el("span", { className: "hint", textContent: "None yet: upload some, or click log snapshots above." }));

    for (const [key, b] of this.buttons) b.disabled = !s.active || (key === "stop" ? !s.script : false);
    const who = s.people === 0 ? "nobody in view" : s.steppedOut ? "visitor stepped out (swapping)" : `${s.people} pretend visitor${s.people > 1 ? "s" : ""} in view`;
    this.status.textContent = s.active
      ? `${who} · frame: ${s.image?.name ?? "none"}${s.script ? ` · script ${s.script}` : ""}`
      : "Off: the real camera drives the creature.";
  }
}
