// PoB codes and the live dashboard (local server, key-protected, two-way).
import { request } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { Dashboard } from "../src/dashboard/dashboard.js";
import { decodePobCode, encodePobCode } from "../src/engine/pobcode.js";

describe("Path of Building codes", () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding2><Build level="90" className="Witch"/></PathOfBuilding2>';

  it("round-trips and uses PoB's URL-safe alphabet", () => {
    const code = encodePobCode(xml);
    expect(code).toMatch(/^[A-Za-z0-9_-]+=*$/);
    expect(decodePobCode(code)).toBe(xml);
    expect(decodePobCode(`  ${code.slice(0, 20)}\n${code.slice(20)}  `)).toBe(xml); // pasted with line breaks
  });

  it("explains bad input", () => {
    expect(() => decodePobCode("https://pobb.in/abc")).toThrow(/link, not a code/);
    expect(() => decodePobCode("notacode!!!")).toThrow(/Path of Building code/);
    expect(() => decodePobCode(encodePobCode("<PathOfBuilding><Build/></PathOfBuilding>"))).toThrow(/Path of Exile 1/);
  });
});

function call(url: string, method = "GET", body?: unknown, host?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { "Content-Type": "application/json", ...(host ? { Host: host } : {}) } },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => {
          text += c.toString();
          // An event stream never ends; the first message is enough.
          if (res.headers["content-type"]?.includes("event-stream") && text.includes("\n\n")) {
            res.destroy();
            resolve({ status: res.statusCode ?? 0, text });
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("dashboard", () => {
  const dash = new Dashboard();
  afterAll(() => dash.stop());

  it("serves the page only with its key, on this machine", async () => {
    const url = await dash.start("Test session");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32}$/);
    const page = await call(url);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Test session");
    const base = url.split("?")[0]!;
    expect((await call(base)).status).toBe(403);
    expect((await call(`${base}?k=wrong`)).status).toBe(403);
    // A page on another site pointing a hostname at this machine (DNS rebinding) is refused.
    expect((await call(url, "GET", undefined, "evil.example")).status).toBe(403);
  });

  it("streams events, including ones published before the page opened", async () => {
    dash.publish({ kind: "thought", title: "Firestorm looks strongest" });
    const url = dash.url!;
    const stream = await call(url.replace("/?", "/events?"));
    const hello = JSON.parse(stream.text.replace(/^data: /, "").trim());
    expect(hello.type).toBe("hello");
    expect(hello.events.some((e: { title: string }) => e.title === "Firestorm looks strongest")).toBe(true);
  });

  it("queues the player's answers until Claude reads them", async () => {
    const q = dash.publish({ kind: "question", title: "Which direction?", options: ["Fire", "Lightning"] });
    const action = dash.url!.replace("/?", "/action?");
    expect((await call(action, "POST", { type: "answer", eventId: q.id, text: "Fire" })).status).toBe(204);
    expect((await call(action, "POST", { type: "hack" })).status).toBe(400);
    expect(dash.waiting).toBe(1);
    const taken = dash.takeActions();
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ type: "answer", text: "Fire", eventTitle: "Which direction?" });
    expect(dash.waiting).toBe(0);
  });
});
