import type { VisionResult } from "../../shared/types.ts";
import type { EngineDeps, EngineEvent, EngineStatus } from "./types.ts";

/** For a return we couldn't check against the last group: don't assume strangers, or the same people. */
export const UNSURE_RETURN =
  "[CAMERA] Someone just walked up after the porch was empty for a bit, but your eyes aren't working right now, " +
  "so you can't tell whether they're the visitors you were just talking to or someone new. Greet them warmly " +
  "without assuming either way: ask whether they're back or new, and what they're dressed as.";

/** Shared WebRTC plumbing for both OpenAI voice engines. */
export abstract class WebRtcEngine {
  status: EngineStatus = "closed";
  remoteStream: MediaStream | null = null;
  protected pc: RTCPeerConnection | null = null;
  protected dc: RTCDataChannel | null = null;
  protected micEnabled = false;
  protected heardAt = 0;
  protected pendingVision = 0;
  private listeners = new Set<(event: EngineEvent) => void>();
  private closing: Promise<void> | null = null;

  constructor(protected readonly deps: EngineDeps) {}

  on(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: EngineEvent): void {
    for (const l of this.listeners) l(event);
  }

  protected setStatus(status: EngineStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: "status", status, detail });
  }

  lastHeardAt(): number {
    return this.heardAt;
  }

  /** Subclasses handle one parsed data-channel event. */
  protected abstract onServerEvent(event: { type: string; [key: string]: unknown }): void;

  /** Resolves once the session is ready for commands. */
  protected abstract waitUntilReady(): Promise<void>;

  async connect(): Promise<void> {
    if (this.status === "open" || this.status === "connecting") return;
    if (this.closing) await this.closing;
    this.setStatus("connecting");
    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.addEventListener("track", (e) => {
        this.remoteStream = e.streams[0] ?? new MediaStream([e.track]);
        this.emit({ type: "note", text: "voice audio connected" });
      });
      pc.addEventListener("connectionstatechange", () => {
        if (pc === this.pc && (pc.connectionState === "failed" || pc.connectionState === "closed")) this.teardown("connection lost");
      });
      for (const track of this.deps.mic.getAudioTracks()) pc.addTrack(track, this.deps.mic);
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.addEventListener("message", ({ data }) => {
        try {
          this.onServerEvent(JSON.parse(String(data)));
        } catch (err) {
          this.emit({ type: "error", message: `bad server event: ${(err as Error).message}` });
        }
      });
      dc.addEventListener("close", () => {
        if (dc === this.dc) this.teardown("event channel closed");
      });

      const ready = this.waitUntilReady();
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc, 3000);
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: pc.localDescription?.sdp, character: this.deps.character, voice: this.deps.voice?.() ?? undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error([body.error ?? `session request failed (${res.status})`, body.detail].filter(Boolean).join(": "));
      }
      const { sdp } = (await res.json()) as { sdp: string };
      await pc.setRemoteDescription({ type: "answer", sdp });
      await withTimeout(ready, 15000, "timed out waiting for the session to start");
      this.setStatus("open");
    } catch (err) {
      this.teardown((err as Error).message);
      throw err;
    }
  }

  close(): Promise<void> {
    if (this.status === "closed") return Promise.resolve();
    this.closing ??= this.gracefulClose()
      .catch(() => undefined)
      .finally(() => {
        this.teardown("closed");
        this.closing = null;
      });
    return this.closing;
  }

  /** Engines with a close handshake override this. */
  protected async gracefulClose(): Promise<void> {}

  protected teardown(reason: string): void {
    if (!this.pc && this.status === "closed") return;
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    this.remoteStream = null;
    this.pendingVision = 0;
    this.setStatus("closed", reason);
  }

  protected send(event: Record<string, unknown>): boolean {
    if (this.dc?.readyState !== "open") return false;
    this.dc.send(JSON.stringify(event));
    return true;
  }

  setMicEnabled(enabled: boolean): void {
    this.micEnabled = enabled;
    for (const track of this.deps.mic.getAudioTracks()) track.enabled = enabled;
  }

  /** Calls the server's vision backend, counting it as "thinking" while it runs. */
  protected async look(
    image: string,
    reason: string,
    opts: { withTranscript?: boolean; quiet?: boolean; previous?: string; previousImage?: string } = {},
  ): Promise<Pick<VisionResult, "text" | "sameGroup" | "verdict">> {
    // Quiet (background) looks don't show as "thinking" on the eyes.
    const counted = !opts.quiet;
    if (counted) this.pendingVision++;
    try {
      const res = await fetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image,
          reason,
          transcript: opts.withTranscript ? this.deps.recentTranscript() : undefined,
          previous: opts.previous,
          previousImage: opts.previousImage,
        }),
      });
      const body = (await res.json()) as {
        text?: string;
        sameGroup?: boolean;
        verdict?: VisionResult["verdict"];
        error?: string;
        usage?: { inputTokens: number; outputTokens: number };
      };
      if (!res.ok || !body.text) throw new Error(body.error ?? `vision failed (${res.status})`);
      if (body.usage) this.emit({ type: "usage", tokens: body.usage.inputTokens + body.usage.outputTokens });
      return { text: body.text, sameGroup: body.sameGroup, verdict: body.verdict };
    } finally {
      if (counted) this.pendingVision = Math.max(0, this.pendingVision - 1);
    }
  }
}

function waitForIce(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    // On timeout, go with the candidates gathered so far rather than failing.
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}
