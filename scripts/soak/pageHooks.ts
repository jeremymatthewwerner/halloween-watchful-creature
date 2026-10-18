/**
 * Runs inside the dashboard page (injected before any page script by the soak test) to:
 *  - stand in for WebRTC: a fake RTCPeerConnection + "oai-events" data channel that behaves like a
 *    GPT-Live session (session.started, transcripts, usage, delegations, session.close/closed,
 *    the occasional dropped connection), with a synthesized voice so the real VoiceMeter, eyes and
 *    "is it talking?" logic all run. The SDP offer still goes through the real server to the mock.
 *  - count what can leak: live timers and intervals, open EventSources and WebSockets, open fake
 *    sessions, in-flight fetches, main-thread stalls, oversized context appends.
 *
 * Must stay self-contained: it is serialized with Function.prototype.toString().
 */

export interface PageHookOptions {
  seed: number;
  /**
   * Drop `rehearsal: true` from vision requests, so the server saves greeting snapshots exactly as on
   * a real night (rehearsal looks normally save none) and disk growth is realistic.
   */
  realSnapshots: boolean;
  /** Chance that a session's connection drops (network) at a random point. */
  dropChance: number;
  /** Chance that the model doesn't answer a greeting request (exercises the nudge). */
  ignoreChance: number;
}

/** One context append the page sent to the (fake) session, for the soak's greeting analysis. */
export interface SoakAppend {
  at: number;
  type: string;
  chars: number;
}

export interface SoakPageSnapshot {
  at: number;
  timeouts: number;
  intervals: number;
  eventSources: number;
  webSockets: number;
  sessionsOpen: number;
  sessionsStarted: number;
  sessionsEnded: number;
  /** Wall ms the fake sessions were open (what GPT-Live would bill). */
  sessionMs: number;
  drops: number;
  fetchInflight: number;
  fetchMaxInflight: number;
  fetches: number;
  slowFetches: number;
  /** Longest main-thread stall since the last snapshot. */
  maxLagMs: number;
  oversizeAppends: number;
  maxAppendChars: number;
  unknownEvents: number;
  /** Nodes in the page's document (elements, text, comments): the rest of Chrome's count is detached. */
  domAttached: number;
}

export function soakPageHooks(o: PageHookOptions): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__soak) return;

  let seed = o.seed >>> 0 || 1;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (min: number, max: number) => min + rand() * (max - min);

  // --- timers --------------------------------------------------------------------------------------
  const native = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    fetch: window.fetch.bind(window),
  };
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  const later = (fn: () => void, ms: number) => native.setTimeout(fn, ms);
  const anyWindow = window as unknown as Record<string, unknown>;
  anyWindow.setTimeout = (handler: unknown, ms?: number, ...args: unknown[]) => {
    const id: number = native.setTimeout(() => {
      timeouts.delete(id);
      if (typeof handler === "function") (handler as (...a: unknown[]) => void)(...args);
    }, ms);
    timeouts.add(id);
    return id;
  };
  anyWindow.setInterval = (handler: unknown, ms?: number, ...args: unknown[]) => {
    const id: number = native.setInterval(() => {
      if (typeof handler === "function") (handler as (...a: unknown[]) => void)(...args);
    }, ms);
    intervals.add(id);
    return id;
  };
  // Browsers let either clear function clear either kind of timer.
  anyWindow.clearTimeout = anyWindow.clearInterval = (id?: number) => {
    if (id === undefined) return;
    timeouts.delete(id);
    intervals.delete(id);
    native.clearTimeout(id);
  };

  // --- main-thread stalls ------------------------------------------------------------------------
  let maxLagMs = 0;
  let lastTick = performance.now();
  native.setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - lastTick - 250);
    lastTick = now;
  }, 250);

  // --- EventSource / WebSocket ---------------------------------------------------------------------
  const sources = new Set<EventSource>();
  const NativeEventSource = window.EventSource;
  anyWindow.EventSource = class extends NativeEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      sources.add(this);
    }
  };
  const sockets = new Set<WebSocket>();
  const NativeWebSocket = window.WebSocket;
  anyWindow.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.add(this);
    }
  };
  const openCount = <T extends { readyState: number }>(set: Set<T>, closed: number) => {
    for (const s of set) if (s.readyState === closed) set.delete(s);
    return set.size;
  };

  // --- fetch -------------------------------------------------------------------------------------
  let fetchInflight = 0;
  let fetchMaxInflight = 0;
  let fetches = 0;
  let slowFetches = 0;
  anyWindow.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, location.href).pathname;
    if (o.realSnapshots && path === "/api/vision" && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        delete body.rehearsal;
        init = { ...init, body: JSON.stringify(body) };
      } catch {
        /* leave it */
      }
    }
    fetches++;
    fetchInflight++;
    fetchMaxInflight = Math.max(fetchMaxInflight, fetchInflight);
    const started = performance.now();
    try {
      return await native.fetch(input, init);
    } finally {
      fetchInflight--;
      // Server-Sent Events go through EventSource, not fetch, so any fetch this slow is a stall.
      if (performance.now() - started > 10_000) slowFetches++;
    }
  };

  // --- a fake GPT-Live session behind a fake RTCPeerConnection ---------------------------------------
  const sessions = { open: 0, started: 0, ended: 0, ms: 0, drops: 0 };
  const appends: SoakAppend[] = [];
  /** Ended sessions' wall-clock spans (epoch ms), from session.started to the end. */
  const spans: { from: number; to: number }[] = [];
  let oversizeAppends = 0;
  let maxAppendChars = 0;
  let unknownEvents = 0;

  /**
   * The synthesized "voice": one tone whose gain goes up while the creature talks, sent to each
   * session as its own stream. Like a real call's remote track, it ends when the session does.
   */
  let voiceCtx: AudioContext | null = null;
  let voiceGain: GainNode | null = null;
  let speakingUntil = 0;
  const voiceStream = (): { stream: MediaStream; end(): void } => {
    if (!voiceCtx) {
      voiceCtx = new AudioContext();
      const osc = voiceCtx.createOscillator();
      osc.frequency.value = 170;
      voiceGain = voiceCtx.createGain();
      voiceGain.gain.value = 0;
      osc.connect(voiceGain);
      osc.start();
    }
    void voiceCtx.resume().catch(() => undefined);
    const dest = voiceCtx.createMediaStreamDestination();
    voiceGain!.connect(dest);
    return {
      stream: dest.stream,
      end() {
        voiceGain?.disconnect(dest);
        for (const track of dest.stream.getTracks()) track.stop();
      },
    };
  };
  const setVoice = (on: boolean) => {
    if (voiceGain && voiceCtx) voiceGain.gain.setTargetAtTime(on ? 0.35 : 0, voiceCtx.currentTime, 0.02);
  };

  const WORDS = "what a magnificent costume oh my goodness I give it three thumbs up and I do not even have thumbs a gold medal for spookiness happy Halloween".split(" ");
  const VISITOR = "trick or treat I am a dinosaur do you like my hat can I have candy what are you".split(" ");

  class FakeChannel extends EventTarget {
    readyState: RTCDataChannelState = "connecting";
    constructor(
      readonly label: string,
      private readonly sim: LiveSim,
    ) {
      super();
    }
    send(data: string): void {
      if (this.readyState !== "open") throw new DOMException("RTCDataChannel.readyState is not 'open'", "InvalidStateError");
      this.sim.receive(JSON.parse(data) as { type: string; [k: string]: unknown });
    }
    close(): void {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.sim.end();
      later(() => this.dispatchEvent(new Event("close")), 0);
    }
    deliver(event: object): void {
      if (this.readyState === "open") this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }
  }

  /** The GPT-Live side of one session. */
  class LiveSim {
    channel: FakeChannel | null = null;
    private startedAt: number | null = null;
    private startedWall = 0;
    private begun = false;
    private ended = false;
    private muted = true;
    private readonly timers = new Set<number>();
    private spoken = 0;
    private busyUntil = 0;

    constructor(private readonly pc: FakePeerConnection) {}

    private after(ms: number, fn: () => void): void {
      const id = later(() => {
        this.timers.delete(id);
        if (!this.ended) fn();
      }, ms);
      this.timers.add(id);
    }

    private send(event: object): void {
      this.channel?.deliver(event);
    }

    start(): void {
      if (this.ended || this.begun) return;
      this.begun = true;
      sessions.open++;
      this.after(between(40, 150), () => {
        this.startedAt = performance.now();
        this.startedWall = Date.now();
        sessions.started++;
        this.send({ type: "session.started", session: { id: `soak_${sessions.started}` } });
        const usage = () =>
          this.after(5000, () => {
            this.send({ type: "session.usage.updated", usage: { seconds: Math.round(this.seconds()) } });
            usage();
          });
        usage();
        if (rand() < o.dropChance) {
          this.after(between(15_000, 90_000), () => {
            sessions.drops++;
            this.pc.fail();
          });
        }
      });
    }

    private seconds(): number {
      return this.startedAt === null ? 0 : (performance.now() - this.startedAt) / 1000;
    }

    receive(msg: { type: string; content?: unknown; delegation_id?: unknown }): void {
      if (typeof msg.content === "string") {
        appends.push({ at: Date.now(), type: msg.type, chars: msg.content.length });
        if (appends.length > 5000) appends.splice(0, appends.length - 5000);
        maxAppendChars = Math.max(maxAppendChars, msg.content.length);
        // GPT-Live takes at most 500 tokens per append: roughly 2,000 characters of English.
        if (msg.content.length > 2000) oversizeAppends++;
      }
      switch (msg.type) {
        case "session.input_audio.mute":
          this.muted = true;
          break;
        case "session.input_audio.unmute":
          this.muted = false;
          break;
        case "session.thinking.append":
          break;
        case "session.commentary.append":
          if (msg.delegation_id || rand() >= o.ignoreChance) this.reply();
          break;
        case "session.instructions.append":
          if (rand() >= o.ignoreChance / 2) this.reply();
          break;
        case "session.close":
          this.after(between(50, 250), () => this.send({ type: "session.closed", reason: "client_closed", usage: { seconds: Math.round(this.seconds()) } }));
          break;
        default:
          unknownEvents++;
      }
    }

    /** Answers like the real model: one response at a time, with a breath between them. */
    private reply(): void {
      const now = performance.now();
      const start = Math.max(now + between(250, 800), this.busyUntil + between(800, 1200));
      const ms = between(1500, 4500);
      this.busyUntil = start + ms;
      this.after(start - now, () => this.speak(ms));
    }

    /** Says a line: the tone plays and transcript deltas stream; sometimes a visitor answers. */
    private speak(ms: number): void {
      speakingUntil = Math.max(speakingUntil, performance.now() + ms);
      setVoice(true);
      const words = Math.max(3, Math.round(ms / 300));
      for (let i = 0; i < words; i++) {
        this.after((i * ms) / words, () => this.send({ type: "session.output_transcript.delta", delta: `${i ? " " : ""}${WORDS[(this.spoken + i) % WORDS.length]}` }));
      }
      this.spoken += words;
      this.after(ms, () => {
        if (performance.now() >= speakingUntil - 5) setVoice(false);
        if (this.muted || rand() > 0.45) return;
        const n = 3 + Math.floor(rand() * 5);
        for (let i = 0; i < n; i++) this.after(600 + i * 220, () => this.send({ type: "session.input_transcript.delta", delta: `${i ? " " : ""}${VISITOR[(this.spoken + i) % VISITOR.length]}` }));
        // Now and then the visitor asks "what am I?": GPT-Live delegates a fresh look to the client.
        if (rand() < 0.2) this.after(700 + n * 220, () => this.send({ type: "session.delegation.created", delegation: { id: `del_${Date.now().toString(36)}`, target: "client" } }));
      });
    }

    end(): void {
      if (this.ended) return;
      this.ended = true;
      for (const id of this.timers) native.clearTimeout(id);
      this.timers.clear();
      if (!this.begun) return;
      sessions.open--;
      sessions.ended++;
      if (this.startedAt !== null) {
        sessions.ms += performance.now() - this.startedAt;
        spans.push({ from: this.startedWall, to: Date.now() });
      }
      if (sessions.open === 0) setVoice(false);
    }
  }

  class FakePeerConnection extends EventTarget {
    connectionState: RTCPeerConnectionState = "new";
    iceGatheringState: RTCIceGatheringState = "new";
    signalingState: RTCSignalingState = "stable";
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    private readonly sim = new LiveSim(this);
    private endVoice: () => void = () => undefined;

    addTrack(): RTCRtpSender {
      return {} as RTCRtpSender;
    }

    createDataChannel(label: string): RTCDataChannel {
      const channel = new FakeChannel(label, this.sim);
      this.sim.channel = channel;
      return channel as unknown as RTCDataChannel;
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return { type: "offer", sdp: "v=0\r\no=- soak 2 IN IP4 127.0.0.1\r\ns=soak-test fake offer\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
    }

    async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
      this.localDescription = description;
      this.iceGatheringState = "complete";
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
      if (this.connectionState === "closed") throw new DOMException("closed", "InvalidStateError");
      // A real browser would choke on anything but a real answer; this only accepts the mock's.
      if (!description.sdp?.includes("soak-test fake answer")) throw new DOMException("not the mock's SDP answer", "OperationError");
      this.remoteDescription = description;
      later(() => {
        if (this.connectionState === "closed") return;
        this.connectionState = "connected";
        this.dispatchEvent(new Event("connectionstatechange"));
        const { stream, end } = voiceStream();
        this.endVoice = end;
        const track = Object.assign(new Event("track"), { streams: [stream], track: stream.getAudioTracks()[0] });
        this.dispatchEvent(track);
        const channel = this.sim.channel;
        if (channel && channel.readyState === "connecting") {
          channel.readyState = "open";
          channel.dispatchEvent(new Event("open"));
        }
        this.sim.start();
      }, between(80, 300));
    }

    /** The network dropped. */
    fail(): void {
      if (this.connectionState === "closed") return;
      this.connectionState = "failed";
      this.dispatchEvent(new Event("connectionstatechange"));
    }

    close(): void {
      if (this.connectionState === "closed") return;
      this.connectionState = "closed";
      this.signalingState = "closed";
      const channel = this.sim.channel;
      if (channel && channel.readyState !== "closed") channel.readyState = "closed";
      this.sim.end();
      this.endVoice();
    }
  }
  anyWindow.RTCPeerConnection = FakePeerConnection;

  const countNodes = () => {
    // Plus one for the document itself, as Chrome's Nodes counter includes it.
    let n = 1;
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
    while (walker.nextNode()) n++;
    return n;
  };

  w.__soak = {
    snapshot(): SoakPageSnapshot {
      const lag = maxLagMs;
      maxLagMs = 0;
      return {
        at: Date.now(),
        timeouts: timeouts.size,
        intervals: intervals.size,
        eventSources: openCount(sources, 2),
        webSockets: openCount(sockets, 3),
        sessionsOpen: sessions.open,
        sessionsStarted: sessions.started,
        sessionsEnded: sessions.ended,
        sessionMs: sessions.ms,
        drops: sessions.drops,
        fetchInflight,
        fetchMaxInflight,
        fetches,
        slowFetches,
        maxLagMs: Math.round(lag),
        oversizeAppends,
        maxAppendChars,
        unknownEvents,
        domAttached: countNodes(),
      };
    },
    /** Context appends, and ended sessions, since the last call. */
    drain(): { appends: SoakAppend[]; sessions: { from: number; to: number }[] } {
      return { appends: appends.splice(0, appends.length), sessions: spans.splice(0, spans.length) };
    },
  };
}
