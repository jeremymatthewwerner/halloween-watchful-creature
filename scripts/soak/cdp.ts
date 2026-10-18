/**
 * A minimal Chrome DevTools Protocol client over a WebSocket (the `ws` package the server already
 * uses), enough to drive headless Chrome and to read a Node process's heap through its inspector.
 * Flat sessions only: page commands carry the sessionId from Target.attachToTarget.
 */
import WebSocket from "ws";

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;

export class Cdp {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; method: string }>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {}, msg.sessionId);
      }
    });
    ws.on("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: CDP connection closed`));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      ws.once("open", () => resolve(new Cdp(ws)));
      ws.once("error", reject);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${method}: CDP connection closed`));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  }

  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Evaluates an expression (awaiting promises) and returns its JSON value; throws on exceptions. */
  async evaluate<T = unknown>(expression: string, sessionId?: string, timeoutMs?: number): Promise<T> {
    const res = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
      timeoutMs,
    );
    if (res.exceptionDetails) throw new Error(`evaluate failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value as T;
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }
}

/** The inspector WebSocket URL of a Node process started with --inspect=host:port. */
export async function nodeInspectorUrl(port: number, timeoutMs = 20_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { webSocketDebuggerUrl?: string }[];
      const url = list[0]?.webSocketDebuggerUrl;
      if (url) return url;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until) throw new Error(`no Node inspector on port ${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
