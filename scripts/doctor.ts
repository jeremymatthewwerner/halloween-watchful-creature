/**
 * Pre-flight check: `npm run doctor`.
 * Verifies Node, the .env settings, OpenAI access to the configured models, a real
 * vision call, the character files and the Arduino connection, without starting a
 * (billed) voice session.
 */
import { existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { listCharacterIds, loadCharacter } from "../server/characters.ts";
import { config } from "../server/config.ts";
import { describeFrame } from "../server/openai.ts";

let failures = 0;
const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const warn = (msg: string) => console.log(`  ⚠️  ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  ❌ ${msg}`);
};

async function main(): Promise<void> {
  console.log("\n🎃 Watchful Creature doctor\n");

  console.log("Setup");
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  if (major > 22 || (major === 22 && minor >= 6)) ok(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node}: need 22.6 or newer`);
  if (existsSync(".env")) ok(".env found");
  else fail(".env missing: run `cp .env.example .env` and add your key");
  if (config.apiKey.startsWith("sk-")) ok("OPENAI_API_KEY is set");
  else fail("OPENAI_API_KEY is missing or doesn't look like an OpenAI key");
  ok(`engine: ${config.engine}, character: ${config.character}, body modes: ${config.bodyModes.join(",") || "none"}`);

  console.log("\nCharacters");
  for (const id of listCharacterIds()) {
    try {
      const c = loadCharacter(id);
      ok(`${id}: ${c.name} (voice ${c.voice})`);
    } catch (err) {
      fail(`${id}: ${(err as Error).message}`);
    }
  }

  if (config.apiKey) {
    console.log("\nOpenAI access");
    const models = config.engine === "live" ? [config.liveModel, config.visionModel] : [config.realtimeModel];
    for (const model of models) {
      const res = await fetch(`${config.apiBase}/models/${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      }).catch((err: Error) => err);
      if (res instanceof Error) fail(`${model}: network error ${res.message}`);
      else if (res.ok) ok(`${model}: available`);
      else if (res.status === 401) fail(`${model}: 401, the API key was rejected`);
      else fail(`${model}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    if (config.engine === "live") {
      console.log("\nVision test (one small call)");
      const started = Date.now();
      try {
        const result = await describeFrame(config, { image: orangeSquarePng(), reason: "manual" });
        ok(`${config.visionModel} answered in ${Date.now() - started} ms: "${result.text.slice(0, 120)}"`);
        if (Date.now() - started > 4000) warn("vision is slow; try VISION_REASONING_EFFORT=minimal or a smaller VISION_MODEL");
      } catch (err) {
        const e = err as Error & { body?: string };
        fail(`vision call failed: ${e.message} ${e.body?.slice(0, 300) ?? ""}`);
      }
    }
  }

  console.log("\nBody (Arduino)");
  if (config.bodySerialPort === "none") {
    ok("disabled (BODY_SERIAL_PORT=none)");
  } else {
    try {
      const { SerialPort } = await import("serialport");
      const ports = await SerialPort.list();
      const arduino = ports.find(
        (p) => /2341|2a03|1a86|10c4|0403|239a/i.test(p.vendorId ?? "") || /usbmodem|usbserial|ttyACM|ttyUSB/i.test(p.path),
      );
      if (arduino) ok(`Arduino-like port: ${arduino.path} ${arduino.manufacturer ?? ""}`);
      else warn("no Arduino found (fine until the eyes are built; the app runs without it)");
    } catch {
      warn("serialport module not available; run npm install");
    }
  }

  console.log(failures ? `\n${failures} problem(s) found.\n` : "\nAll good! Run `npm run dev` and open http://localhost:5173\n");
  process.exitCode = failures ? 1 : 0;
}

/** A tiny solid-orange PNG, so the vision test needs no files or camera. */
function orangeSquarePng(size = 32): string {
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([255, 120, 0], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

void main();
