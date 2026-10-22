// A live dashboard in the player's browser: what Claude is testing and thinking, as it happens,
// and a way for the player to answer, steer and comment. Served from this machine only
// (127.0.0.1, a random key in the URL); nothing leaves the PC.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dashboardPage } from "./page.js";

export type EventKind = "status" | "thought" | "plan" | "question" | "decision" | "test" | "compare" | "optimize" | "character" | "upgrades";

export interface DashboardEvent {
  id: number;
  time: string;
  kind: EventKind;
  title: string;
  text?: string;
  /** Answer buttons for a question. */
  options?: string[];
  /** Structured numbers the page draws (test results, comparisons…). */
  data?: unknown;
}

export interface PlayerAction {
  time: string;
  /** "answer" (to a question), "keep" / "drop" (a test), "comment", "message". */
  type: string;
  /** The event it's about, if any. */
  eventId?: number;
  eventTitle?: string;
  text?: string;
}

const PREFERRED_PORT = 47_821;
const MAX_EVENTS = 500;

export class Dashboard {
  private server?: Server;
  private port?: number;
  private readonly token = randomBytes(16).toString("hex");
  private readonly events: DashboardEvent[] = [];
  private readonly clients = new Set<ServerResponse>();
  private readonly pending: PlayerAction[] = [];
  private nextId = 1;
  private session = "Build session";

  get running(): boolean {
    return !!this.server;
  }

  get url(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/?k=${this.token}` : undefined;
  }

  /** Player actions not yet read by Claude. */
  get waiting(): number {
    return this.pending.length;
  }

  async start(title?: string): Promise<string> {
    if (title) this.session = title;
    if (this.server) {
      this.broadcast({ type: "session", title: this.session });
      return this.url!;
    }
    const server = createServer((req, res) => this.handle(req, res));
    this.port = await new Promise<number>((resolve, reject) => {
      const listen = (port: number) => {
        server.once("error", (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" && port !== 0 ? listen(0) : reject(error)));
        server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
      };
      listen(PREFERRED_PORT);
    });
    server.unref(); // never keep the extension alive just for the dashboard
    this.server = server;
    return this.url!;
  }

  stop(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
  }

  /** Add an event to the feed (kept even before the page is opened, so it can catch up). */
  publish(event: Omit<DashboardEvent, "id" | "time">): DashboardEvent {
    const full: DashboardEvent = { ...event, id: this.nextId++, time: new Date().toISOString() };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.broadcast({ type: "event", event: full });
    return full;
  }

  /** Hand over (and clear) what the player did since Claude last looked. */
  takeActions(): PlayerAction[] {
    const actions = this.pending.splice(0);
    this.broadcast({ type: "read", count: actions.length });
    return actions;
  }

  private broadcast(message: unknown) {
    const line = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of this.clients) client.write(line);
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Only this machine, only with the key, and only addressed to us (guards against DNS rebinding).
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if ((host !== "127.0.0.1" && host !== "localhost") || url.searchParams.get("k") !== this.token) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(EXPIRED_PAGE);
      return;
    }
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        ...headers,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      });
      res.end(dashboardPage(this.session));
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { ...headers, "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", session: this.session, events: this.events, waiting: this.pending.length })}\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      ping.unref();
      req.on("close", () => {
        clearInterval(ping);
        this.clients.delete(res);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/action") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > 20_000) req.destroy();
      });
      req.on("end", () => {
        try {
          const a = JSON.parse(body) as Partial<PlayerAction>;
          const type = String(a.type ?? "");
          if (!["answer", "keep", "drop", "comment", "message"].includes(type)) throw new Error("bad type");
          const ev = typeof a.eventId === "number" ? this.events.find((e) => e.id === a.eventId) : undefined;
          const action: PlayerAction = {
            time: new Date().toISOString(),
            type,
            eventId: ev?.id,
            eventTitle: ev?.title,
            text: typeof a.text === "string" ? a.text.slice(0, 2000) : undefined,
          };
          this.pending.push(action);
          this.broadcast({ type: "action", action, waiting: this.pending.length });
          res.writeHead(204, headers).end();
        } catch {
          res.writeHead(400, headers).end();
        }
      });
      return;
    }
    res.writeHead(404, headers).end();
  }
}

const EXPIRED_PAGE = `<!doctype html><meta charset="utf-8"><title>Dashboard closed</title>
<body style="font:16px system-ui;background:#0f1115;color:#e6e3dc;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center">
<div><h1>This dashboard session has ended</h1><p style="color:#9ea3ad">Ask Claude to open the dashboard again.</p></div></body>`;
