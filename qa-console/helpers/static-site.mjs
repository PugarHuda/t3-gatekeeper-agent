// Serve ../site the way Vercel does, minus the CDN: static files, a few
// content types, 404 for anything else. For tests that must run offline.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "site");
const TYPES = {
  html: "text/html; charset=utf-8", png: "image/png", svg: "image/svg+xml", mp4: "video/mp4",
  srt: "text/plain", json: "application/json", txt: "text/plain; charset=utf-8",
};

export function serveSite() {
  const server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    try {
      const body = await readFile(path.join(SITE, p));
      const ext = p.split(".").pop();
      res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404); res.end("not found");
    }
  }).listen(0);
  return { server, url: `http://localhost:${server.address().port}`, close: () => server.close() };
}
