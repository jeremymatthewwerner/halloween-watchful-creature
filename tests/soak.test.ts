import { afterEach, describe, expect, it } from "vitest";
import { awakeWindows, greetings, merge, outside } from "../scripts/soak/analysis.ts";
import { leakChecks, slopePerHour, toCsv, type Sample } from "../scripts/soak/metrics.ts";
import { describe as describeImage, pickVerdict, startMockOpenAI, type MockOpenAI } from "../scripts/soak/mockOpenAI.ts";
import { planEvening, projectBilling, quietWindows, type Step } from "../scripts/soak/scenario.ts";

const IMAGES = [1, 1, 2, 2, 3, 3, 4, 4];

describe("soak scenario", () => {
  const plan = planEvening({ hours: 4, seed: 1031, images: IMAGES });

  it("is the same evening for the same seed, and another for another seed", () => {
    expect(planEvening({ hours: 4, seed: 1031, images: IMAGES })).toEqual(plan);
    expect(planEvening({ hours: 4, seed: 7, images: IMAGES }).steps).not.toEqual(plan.steps);
  });

  it("plans a busy Halloween compressed into about an hour", () => {
    expect(plan.groups).toBeGreaterThan(100);
    expect(plan.groups).toBeLessThan(220);
    expect(plan.wallMs).toBeGreaterThan(30 * 60_000);
    expect(plan.wallMs).toBeLessThan(90 * 60_000);
    expect(plan.visits["swap-in"] + plan.visits["return-soon"] + plan.visits["return-later"]).toBeGreaterThan(5);
    expect(plan.flickers).toBeGreaterThan(0);
    expect(plan.settings).toEqual({ idleCloseSeconds: 15, backgroundFrameSeconds: 10 });
  });

  it("alternates arrivals and departures, in time order, with remote presses and one outage", () => {
    let here = false;
    let last = -Infinity;
    for (const s of plan.steps) {
      expect(s.at).toBeGreaterThanOrEqual(last);
      last = s.at;
      if (s.do === "arrive") {
        expect(here).toBe(false);
        here = true;
      }
      if (s.do === "leave") {
        expect(here).toBe(true);
        here = false;
      }
      if (s.do === "join" || s.do === "swap" || s.do === "flicker") expect(here).toBe(s.do !== "flicker");
    }
    expect(here).toBe(false);
    const remote = plan.steps.filter((s) => s.do === "remote");
    expect(remote.length).toBeGreaterThan(10);
    expect(remote.filter((s) => s.do === "remote" && s.command.type === "sleep").length).toBe(remote.filter((s) => s.do === "remote" && s.command.type === "wake").length);
    expect(plan.steps.filter((s) => s.do === "outage")).toHaveLength(2);
    // It ends with Greet now on the empty porch, once the session has gone to sleep.
    const lastLeave = plan.steps.filter((s) => s.do === "leave").at(-1)!;
    expect(plan.steps.at(-1)).toMatchObject({ do: "remote", command: { type: "greet" } });
    expect(plan.steps.at(-1)!.at - lastLeave.at).toBeGreaterThan(8000 + plan.settings.idleCloseSeconds * 1000);
  });

  it("projects the real night's sessions: one per busy stretch, closing 3 minutes after the porch empties", () => {
    // Two visits 60 s apart share a session; one 10 minutes later gets its own.
    expect(projectBilling([[0, 30_000], [90_000, 120_000], [720_000, 750_000]])).toEqual({ sessions: 2, billedMinutes: 8.8 }); // 308 s + 218 s
    // A passer-by who only flickered keeps it awake for the 15 s sighting grace.
    expect(projectBilling([[0, 0]])).toEqual({ sessions: 1, billedMinutes: 0.3 });
    expect(plan.projected.sessions).toBeGreaterThan(0);
    expect(plan.projected.billedMinutes).toBeLessThan(240);
  });

  it("knows when no greetings are expected: kill switch on, OpenAI down", () => {
    const steps: Step[] = [
      { at: 1000, do: "remote", command: { type: "sleep" } },
      { at: 5000, do: "remote", command: { type: "wake" } },
      { at: 9000, do: "outage", on: true },
      { at: 10_000, do: "outage", on: false },
    ];
    expect(quietWindows(steps, 100)).toEqual([
      [1000, 5100],
      [9000, 25_100],
    ]);
  });
});

describe("soak metrics", () => {
  const series = (f: (minutes: number) => number, minutes = 60): Sample[] =>
    Array.from({ length: minutes + 1 }, (_, m) => ({ t: m * 60_000, serverHeapUsed: f(m), domNodes: 1000, pageIntervals: 10, maxLagMs: 20 }));

  it("measures growth per hour", () => {
    expect(slopePerHour(series((m) => 10 + m), "serverHeapUsed")).toBeCloseTo(60);
    expect(slopePerHour(series(() => 5), "serverHeapUsed")).toBe(0);
    expect(slopePerHour([{ t: 0, x: 1 }], "x")).toBeNaN();
  });

  it("fails a steady leak, passes a flat line, and skips a run too short to tell", () => {
    const leak = series((m) => 20e6 + m * 200_000); // 12 MB an hour
    const heap = (samples: Sample[], minSlopeSpanMs?: number) => leakChecks(samples, { warmupMs: 5 * 60_000, minSlopeSpanMs }).find((c) => c.name.startsWith("server heap"))!;
    expect(heap(leak).pass).toBe(false);
    expect(heap(series(() => 20e6)).pass).toBe(true);
    expect(heap(leak, 2 * 3_600_000).pass).toBeNull();
  });

  it("flags timers that pile up and stalls", () => {
    const samples = series(() => 1).map((s, i) => ({ ...s, pageIntervals: 10 + Math.floor(i / 10), maxLagMs: i === 30 ? 5000 : 20 }));
    const checks = leakChecks(samples, { warmupMs: 0 });
    expect(checks.find((c) => c.name.startsWith("browser intervals"))!.pass).toBe(false);
    expect(checks.find((c) => c.name.startsWith("browser main-thread stall"))!.pass).toBe(false);
  });

  it("writes CSV with a column per key", () => {
    expect(toCsv([{ t: 0, a: 1.23456 }, { t: 1000, b: NaN, a: 2 }])).toBe("t,a,b\n0,1.235,\n1000,2,\n");
  });
});

describe("soak analysis", () => {
  const steps: Step[] = [
    { at: 10_000, do: "arrive", image: 0, kind: "new" },
    { at: 30_000, do: "leave" },
    { at: 50_000, do: "arrive", image: 1, kind: "return-soon" },
    { at: 60_000, do: "leave" },
    { at: 400_000, do: "arrive", image: 2, kind: "new" },
    { at: 420_000, do: "leave" },
  ];

  it("works out when a session may be awake, and how long one stayed open past that", () => {
    const windows = awakeWindows(steps, 15, 10_000);
    expect(windows).toEqual([
      [10_000, 93_000],
      [400_000, 453_000],
    ]);
    expect(outside([0, 100_000], windows)).toBe(17_000);
    expect(outside([20_000, 90_000], windows)).toBe(0);
    expect(merge([[5, 10], [0, 6], [20, 30]])).toEqual([[0, 10], [20, 30]]);
  });

  it("checks that new groups were greeted, and only counts returns", () => {
    const report = greetings(
      steps,
      [
        { t: 11_000, type: "session.commentary.append" },
        { t: 52_000, type: "session.thinking.append" },
        { t: 401_000, type: "session.thinking.append" },
      ],
      [],
    );
    expect(report.byKind.new).toEqual({ greeted: 1, silent: 1, none: 0 });
    expect(report.byKind["return-soon"]).toEqual({ greeted: 0, silent: 1, none: 0 });
    expect(report.missed).toEqual([{ at: 400_000, kind: "new", got: "silent" }]);
    expect(greetings(steps, [], [[0, 1_000_000]]).skipped).toBe(3);
  });
});

describe("mock OpenAI", () => {
  let mock: MockOpenAI | null = null;
  afterEach(async () => {
    await mock?.close();
    mock = null;
  });
  const post = (path: string, body: unknown, auth = true) =>
    fetch(`${mock!.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth && { authorization: "Bearer sk-test" }) }, body: JSON.stringify(body) });
  const vision = (text: string, images: string[]) => ({ model: "m", input: [{ role: "user", content: [{ type: "input_text", text }, ...images.map((image_url) => ({ type: "input_image", image_url }))] }] });
  const COMPARE = 'Begin your reply with exactly one of: "NEW:" ... "CHANGED:" ... otherwise "SAME:"';

  it("answers each endpoint the app uses, and counts the calls", async () => {
    mock = await startMockOpenAI({ latencyMs: { min: 0, max: 0 } });
    const live = (await (await post("/live/sessions", { session: { model: "gpt-live-1" }, transport: { sdp: "v=0" } })).json()) as { session: { id: string }; transport: { sdp: string } };
    expect(live.session.id).toMatch(/^sess_soak_/);
    expect(live.transport.sdp).toContain("soak-test fake answer");

    const plain = (await (await post("/responses", vision("Describe the costumes.", ["data:image/jpeg;base64,AAAA"]))).json()) as { output: { content: { text: string }[] }[] };
    expect(plain.output[0]!.content[0]!.text).toMatch(/visitor/);
    expect(plain.output[0]!.content[0]!.text).not.toMatch(/^(SAME|NEW|CHANGED):/);

    const image = (await (await post("/images/generations", { prompt: "Exactly 3 people are visible" })).json()) as { data: { b64_json: string }[]; usage: object };
    expect(Buffer.from(image.data[0]!.b64_json, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect((await post("/audio/speech", { input: "hi" })).headers.get("content-type")).toBe("audio/mpeg");
    expect((await fetch(`${mock.url}/realtime/calls`, { method: "POST", headers: { authorization: "Bearer x" }, body: "sdp" })).status).toBe(201);

    expect((await post("/models", {})).status).toBe(404);
    expect((await post("/responses", {}, false)).status).toBe(401);
    expect(mock.stats.calls).toMatchObject({ live: 1, responses: 2, images: 1, speech: 1, realtime: 1 });
    expect(mock.stats.unknownPaths).toBe(1);
    expect(mock.stats.unauthorized).toBe(1);
  });

  it("gives SAME for the greeting photo again, NEW or CHANGED for a different one, and fails during an outage", async () => {
    mock = await startMockOpenAI({ latencyMs: { min: 0, max: 0 } });
    const text = async (body: unknown) => ((await (await post("/responses", body)).json()) as { output: { content: { text: string }[] }[] }).output[0]!.content[0]!.text;
    expect(await text(vision(COMPARE, ["data:image/jpeg;base64,A", "data:image/jpeg;base64,A"]))).toMatch(/^SAME: /);
    expect(await text(vision(COMPARE, ["data:image/jpeg;base64,A", "data:image/jpeg;base64,B"]))).toMatch(/^(NEW|CHANGED): /);
    mock.setOutage(true);
    expect((await post("/responses", vision("x", ["data:image/jpeg;base64,A"]))).status).toBe(503);
    expect(mock.stats.outageFailures).toBe(1);
  });

  it("picks verdicts that the server's parser understands", () => {
    expect(pickVerdict("Describe.", ["a"], 0)).toBeNull();
    // A return check only knows SAME and NEW.
    for (let turn = 0; turn < 10; turn++) expect(["SAME", "NEW"]).toContain(pickVerdict('Begin your reply with exactly "SAME:" only if', ["a", "b"], turn));
    expect(describeImage("data:image/jpeg;base64,xyz")).toBe(describeImage("data:image/jpeg;base64,xyz"));
  });
});
