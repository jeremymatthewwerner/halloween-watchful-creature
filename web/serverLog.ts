import type { ServerLogEntry } from "../shared/types.ts";

const MAX_LINES = 500;
/** The server pings every 5 s; this long without hearing anything means the stream is dead. */
const STALE_MS = 12_000;

/**
 * Follows the server's console output (/api/logs) in a scrolling list. It sticks to the newest
 * line unless the operator has scrolled up to read something.
 */
export function followServerLog(list: HTMLOListElement, status: HTMLElement): void {
  let boot: string | null = null;
  let lastSeq = 0;
  let lastHeard = Date.now();
  let source: EventSource;

  const append = (text: string, className: string, at?: number) => {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    const li = document.createElement("li");
    li.className = className;
    if (at !== undefined) {
      const time = document.createElement("time");
      time.textContent = new Date(at).toLocaleTimeString();
      li.append(time, " ");
    }
    li.append(text);
    list.append(li);
    while (list.children.length > MAX_LINES) list.firstElementChild?.remove();
    if (atBottom) list.scrollTop = list.scrollHeight;
  };

  const setStatus = (text: string, className: string) => {
    status.textContent = text;
    status.className = `log-status ${className}`;
  };

  const connect = () => {
    lastHeard = Date.now();
    source = new EventSource("/api/logs");
    source.onopen = () => {
      lastHeard = Date.now();
      setStatus("live", "on");
    };
    source.onerror = () => setStatus("server unreachable: retrying…", "bad");
    source.addEventListener("ping", () => (lastHeard = Date.now()));
    source.onmessage = (message: MessageEvent<string>) => {
      lastHeard = Date.now();
      const entry = JSON.parse(message.data) as ServerLogEntry;
      // A reconnect replays the server's backlog: skip what's already shown.
      if (entry.boot === boot && entry.seq <= lastSeq) return;
      if (boot !== null && entry.boot !== boot) append("server restarted", "restart");
      boot = entry.boot;
      lastSeq = entry.seq;
      append(entry.text, entry.level, entry.at);
    };
  };

  connect();
  setInterval(() => {
    if (Date.now() - lastHeard < STALE_MS) return;
    setStatus("reconnecting…", "bad");
    source.close();
    connect();
  }, 3000);
}
