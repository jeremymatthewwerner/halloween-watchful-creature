/**
 * The soak test's evening: trick-or-treater groups arriving through a Halloween night, compressed
 * into much less wall time. Pure (seeded randomness, no I/O) so it's unit tested.
 *
 * The evening is planned in "evening time" (real seconds on the night), then laid out in wall time:
 * empty-porch gaps shrink a lot, visits shrink a little, and the timings the tracker and the director
 * use on their own (8 s to count as left, 90 s to count as a return, 45 s for a welcome back) are
 * left real, since the dashboard code runs at normal speed. The server's own timing knobs
 * (IDLE_CLOSE_SECONDS, BACKGROUND_FRAME_SECONDS) shrink by the same factors.
 */
export type Rng = () => number;

/** A remote command as the phone sends it (the server adds the id). */
export type RemoteBody = { type: "sleep" | "wake" | "greet" } | { type: "say"; text: string } | { type: "mode"; mode: string; on: boolean };

export type VisitKind = "new" | "return-soon" | "return-later" | "swap-in";

export type Step =
  /** Make sample image `image` the camera frame, then a group arrives. */
  | { at: number; do: "arrive"; image: number; kind: VisitKind }
  | { at: number; do: "join" }
  | { at: number; do: "swap" }
  | { at: number; do: "leave" }
  /** Someone close for a moment (under the 0.7 s it takes to count): wakes the session, then nobody arrives. */
  | { at: number; do: "flicker"; image: number }
  | { at: number; do: "remote"; command: RemoteBody }
  /** The mock OpenAI fails every call while on. */
  | { at: number; do: "outage"; on: boolean };

export interface PlanOptions {
  /** Length of the evening, in hours. */
  hours: number;
  seed: number;
  /** Group size of each sample image, by index. */
  images: readonly number[];
  /** Empty-porch gaps run this many times faster than on the night. */
  gapSpeed?: number;
  /** Visits run this many times faster than on the night. */
  staySpeed?: number;
}

export interface Plan {
  steps: Step[];
  /** When the last step happens, ms after the start. */
  wallMs: number;
  eveningMs: number;
  /** Visitor groups (not counting returns of the same group). */
  groups: number;
  visits: Record<VisitKind, number>;
  flickers: number;
  /** Server settings for the compressed run. */
  settings: { idleCloseSeconds: number; backgroundFrameSeconds: number };
  gapSpeed: number;
  staySpeed: number;
  /** The same evening at the real timings (IDLE_CLOSE_SECONDS=180): voice sessions and their minutes. */
  projected: { sessions: number; billedMinutes: number };
}

/** The real night's settings and the tracker's own timings (web/visitors.ts, server/config.ts). */
export const REAL = { idleCloseSeconds: 180, backgroundFrameSeconds: 30, leaveMs: 8000, regreetMs: 90_000, sightingGraceMs: 15_000 };

/** Groups per hour through a typical Halloween, from 5:30 pm: a build-up, a peak, a tail. */
export const ARRIVALS_PER_HOUR: readonly { untilHour: number; rate: number }[] = [
  { untilHour: 0.5, rate: 20 },
  { untilHour: 1, rate: 35 },
  { untilHour: 2.5, rate: 55 },
  { untilHour: 3.25, rate: 35 },
  { untilHour: Infinity, rate: 15 },
];

const rateAt = (hour: number) => ARRIVALS_PER_HOUR.find((r) => hour < r.untilHour)!.rate;

/** Wall gap long enough that the tracker counts the porch as empty first (leaveMs + a margin). */
const MIN_GAP_MS = REAL.leaveMs + 1500;
const MIN_STAY_MS = 10_000;

const REMOTE_ROTATION: readonly RemoteBody[] = [
  { type: "greet" },
  { type: "say", text: "Only one piece each, please!" },
  { type: "mode", mode: "candyLow", on: true },
  { type: "sleep" },
  { type: "mode", mode: "candyLow", on: false },
  { type: "mode", mode: "toddler", on: true },
  { type: "say", text: "Happy Halloween, everybody!" },
  { type: "mode", mode: "toddler", on: false },
];

/** A seeded PRNG (mulberry32). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plans an evening. Deterministic for a given seed. */
export function planEvening(opts: PlanOptions): Plan {
  const rng = seeded(opts.seed);
  const between = (min: number, max: number) => min + rng() * (max - min);
  const gapSpeed = opts.gapSpeed ?? 12;
  const staySpeed = opts.staySpeed ?? 3;
  const eveningMs = opts.hours * 3_600_000;
  const imageCount = opts.images.length;
  if (imageCount < 2) throw new Error("the soak needs at least two sample images");

  const steps: Step[] = [];
  const visits: Record<VisitKind, number> = { new: 0, "return-soon": 0, "return-later": 0, "swap-in": 0 };
  /** Presence on the night, in evening ms, for the billing projection: [arrive, leave] (flickers: leave = arrive). */
  const presence: [number, number][] = [];
  let flickers = 0;
  let groups = 0;
  let wall = 20_000; // let the dashboard settle first
  let evening = 0;
  let lastImage = -1;

  const stayWall = (stayEvening: number) => Math.max(MIN_STAY_MS, stayEvening / staySpeed);

  while (evening < eveningMs) {
    // The next group: exponential gaps around the hour's rate, minus a typical visit.
    const meanGap = Math.max(5_000, 3_600_000 / rateAt(evening / 3_600_000) - 45_000);
    const gapEvening = -Math.log(1 - rng()) * meanGap;
    let gapWall = Math.max(MIN_GAP_MS, gapEvening / gapSpeed);
    const swapIn = groups > 0 && rng() < 0.05;
    if (swapIn) gapWall = between(3_000, 6_000); // the next group steps in before "left" counts: a gap
    // A passer-by who comes close for a moment, in a long enough empty stretch.
    if (!swapIn && gapWall > 30_000 && rng() < 0.35) {
      steps.push({ at: wall + gapWall / 2, do: "flicker", image: Math.floor(rng() * imageCount) });
      presence.push([evening + gapEvening / 2, evening + gapEvening / 2]);
      flickers++;
    }
    wall += gapWall;
    evening += swapIn ? gapWall : gapEvening;
    if (evening >= eveningMs) break;

    let image = Math.floor(rng() * imageCount);
    if (image === lastImage) image = (image + 1) % imageCount;
    groups++;
    const kind: VisitKind = swapIn ? "swap-in" : "new";
    visits[kind]++;
    const stayEvening = between(20_000, 70_000);
    const stay = stayWall(stayEvening);
    steps.push({ at: wall, do: "arrive", image, kind });
    const join = rng() < 0.25;
    const swap = !join && rng() < 0.15;
    if (join) steps.push({ at: wall + stay * between(0.35, 0.55), do: "join" });
    if (swap) steps.push({ at: wall + stay * between(0.45, 0.65), do: "swap" });
    lastImage = swap ? (image + 1) % imageCount : image;
    presence.push([evening, evening + stayEvening]);
    wall += stay;
    evening += stayEvening;
    steps.push({ at: wall, do: "leave" });

    // Sometimes the same group comes back (a sibling forgot something; a photo with the pumpkin).
    // Away times stay real: "returned" and "welcome back" are decided by real-time thresholds.
    const back = !join && !swap ? rng() : 1;
    if (back < 0.14) {
      const later = back < 0.06;
      // "Away" for the tracker starts when "left" fires, 8 s after they go: soon is under 45 s, later over.
      const away = later ? between(60_000, 82_000) : between(14_000, 35_000);
      const kindBack: VisitKind = later ? "return-later" : "return-soon";
      visits[kindBack]++;
      wall += away;
      evening += away;
      const again = stayWall(between(15_000, 40_000));
      steps.push({ at: wall, do: "arrive", image, kind: kindBack });
      presence.push([evening, evening + again * staySpeed]);
      wall += again;
      evening += again * staySpeed;
      steps.push({ at: wall, do: "leave" });
    }
  }

  // The end of the night: the porch has been empty a while and the session has gone to sleep; the
  // owner presses Greet now from the phone to check it still works. It should go back to sleep.
  const testAt = wall + REAL.leaveMs + (REAL.idleCloseSeconds / gapSpeed) * 1000 + 15_000;
  steps.push({ at: testAt, do: "remote", command: { type: "greet" } });

  // The phone remote: a press every few minutes, rotating through its buttons. Sleep is followed by Wake.
  const wallEnd = testAt + 5_000;
  let next = 90_000;
  for (let i = 0; next < wallEnd - 60_000; i++) {
    const command = REMOTE_ROTATION[i % REMOTE_ROTATION.length]!;
    steps.push({ at: next, do: "remote", command });
    if (command.type === "sleep") steps.push({ at: next + between(20_000, 40_000), do: "remote", command: { type: "wake" } });
    next += between(150_000, 270_000);
  }

  // One OpenAI outage of 75 s, about 60% of the way through the visits (too short an evening: none).
  const outageAt = Math.round(wall * 0.6);
  if (wall > 5 * 60_000) steps.push({ at: outageAt, do: "outage", on: true }, { at: outageAt + 75_000, do: "outage", on: false });

  steps.sort((a, b) => a.at - b.at);
  return {
    steps: steps.map((s) => ({ ...s, at: Math.round(s.at) })),
    wallMs: Math.round(wallEnd),
    eveningMs,
    groups,
    visits,
    flickers,
    settings: {
      idleCloseSeconds: Math.max(10, Math.round(REAL.idleCloseSeconds / gapSpeed)),
      backgroundFrameSeconds: Math.max(5, Math.round(REAL.backgroundFrameSeconds / staySpeed)),
    },
    gapSpeed,
    staySpeed,
    projected: projectBilling(presence),
  };
}

/**
 * Voice sessions and billed minutes on the real night for these visits: a session opens when
 * someone appears and closes IDLE_CLOSE_SECONDS after the porch empties (counted LEAVE_MS after the
 * last person goes), unless someone comes first; a flicker closes after the sighting grace.
 */
export function projectBilling(presence: readonly [number, number][], real = REAL): { sessions: number; billedMinutes: number } {
  const spans = presence
    .map(([from, to]): [number, number] => [from, to === from ? from + real.sightingGraceMs : to + real.leaveMs + real.idleCloseSeconds * 1000])
    .sort((a, b) => a[0] - b[0]);
  let sessions = 0;
  let ms = 0;
  let open: [number, number] | null = null;
  for (const span of spans) {
    if (open && span[0] <= open[1]) {
      open[1] = Math.max(open[1], span[1]);
      continue;
    }
    if (open) ms += open[1] - open[0];
    open = [...span];
    sessions++;
  }
  if (open) ms += open[1] - open[0];
  return { sessions, billedMinutes: Math.round((ms / 60_000) * 10) / 10 };
}

/** Windows (wall ms) when greetings aren't expected: the kill switch is on, or OpenAI is down. */
export function quietWindows(steps: readonly Step[], afterMs = 20_000): [number, number][] {
  const windows: [number, number][] = [];
  let sleepAt: number | null = null;
  let outageAt: number | null = null;
  for (const s of steps) {
    if (s.do === "remote" && s.command.type === "sleep") sleepAt = s.at;
    if (s.do === "remote" && s.command.type === "wake" && sleepAt !== null) {
      windows.push([sleepAt, s.at + afterMs]);
      sleepAt = null;
    }
    if (s.do === "outage" && s.on) outageAt = s.at;
    if (s.do === "outage" && !s.on && outageAt !== null) {
      // Plus the director's 15 s back-off after a failed start.
      windows.push([outageAt, s.at + afterMs + 15_000]);
      outageAt = null;
    }
  }
  return windows;
}
