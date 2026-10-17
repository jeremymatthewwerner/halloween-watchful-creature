import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";
import type { PersonBox } from "./visitors.ts";

// Keep in sync with the installed @mediapipe/tasks-vision version.
const MEDIAPIPE_VERSION = "1.1.1";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

export interface DetectedPerson extends PersonBox {
  /** Normalized box (0..1) for drawing. */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

/** The creature's eyes: a webcam stream plus JPEG snapshots for the model. */
export class Camera {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private canvas = document.createElement("canvas");

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async start(deviceId?: string): Promise<void> {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  get ready(): boolean {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  /** Current frame as a JPEG data URL, downscaled to keep vision calls cheap and fast. */
  capture(maxWidth = 768, quality = 0.7): string | null {
    if (!this.ready) return null;
    const scale = Math.min(1, maxWidth / this.video.videoWidth);
    this.canvas.width = Math.round(this.video.videoWidth * scale);
    this.canvas.height = Math.round(this.video.videoHeight * scale);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.toDataURL("image/jpeg", quality);
  }
}

/** Local, free person detection (runs in the browser) that decides when to involve the model. */
export class PersonDetector {
  private constructor(private readonly detector: ObjectDetector) {}

  static async create(): Promise<PersonDetector> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const detector = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      categoryAllowlist: ["person"],
      scoreThreshold: 0.45,
      maxResults: 8,
    });
    return new PersonDetector(detector);
  }

  detect(video: HTMLVideoElement, now: number): DetectedPerson[] {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return [];
    const result = this.detector.detectForVideo(video, now);
    return result.detections.flatMap((d) => {
      const b = d.boundingBox;
      if (!b) return [];
      const x = b.originX / vw;
      const y = b.originY / vh;
      const w = b.width / vw;
      const h = b.height / vh;
      return [{ x, y, w, h, area: w * h, score: d.categories[0]?.score ?? 0 }];
    });
  }
}
