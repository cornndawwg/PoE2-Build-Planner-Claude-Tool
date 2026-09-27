// Serves the static site. Railway sets PORT.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8" };
const security = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

createServer(async (req, res) => {
  // One address for search engines: www → the bare domain.
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "").toString().split(",")[0].trim();
  if (host.startsWith("www.")) {
    res.writeHead(301, { Location: `https://${host.slice(4)}${req.url ?? "/"}` }).end();
    return;
  }
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const file = normalize(join(root, path === "/" ? "index.html" : path));
  const send = async (status, path) => {
    let body = await readFile(path);
    const type = types[extname(path)] ?? "application/octet-stream";
    const headers = { "Content-Type": type, "Cache-Control": extname(path) === ".html" ? "no-cache" : "public, max-age=86400", Vary: "Accept-Encoding", ...security };
    // Text compresses well; images are already compressed.
    if (/text|xml|svg/.test(type) && /gzip/.test(req.headers["accept-encoding"] ?? "")) {
      body = gzipSync(body);
      headers["Content-Encoding"] = "gzip";
    }
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  };
  const hidden = !file.startsWith(root) || file.endsWith(".mjs") || file.endsWith("package.json");
  try {
    if (hidden) throw new Error("hidden");
    await send(200, file);
  } catch {
    await send(404, join(root, "404.html")).catch(() => res.writeHead(404).end("Not found"));
  }
}).listen(Number(process.env.PORT ?? 8080), () => console.log(`site on ${process.env.PORT ?? 8080}`));
