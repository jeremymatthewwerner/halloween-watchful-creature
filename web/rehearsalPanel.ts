/**
 * The Rehearsal panel (under Settings) and the on-video banner. All the logic is in rehearsal.ts;
 * this only builds the DOM, loads sample images and calls it.
 */
import { galleryItems } from "../server/gallery.ts";
import { logDays, type Rehearsal, type RehearsalAction, type RehearsalImage, type RehearsalSnapshot } from "./rehearsal.ts";
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
        el("h3", {}, "Chosen (click one to make it the camera frame)"),
        this.thumbs,
        el(
          "div",
          { className: "buttons" },
          button("arrive", "🚶 Visitor arrives", act("arrive")),
          button("leave", "👋 Leaves", act("leave")),
          button("swap", "🔁 Swap to next image", act("swap")),
          button("join", "👯 Second visitor joins", act("join")),
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
