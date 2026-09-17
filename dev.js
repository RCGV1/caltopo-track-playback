import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { getPlayback, PlaybackError } from "./api/playback.js";

const PORT = process.env.PORT || 3000;
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  
  if (url.pathname === "/api/playback") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      const data = await getPlayback(url.searchParams.get("url") || url.searchParams.get("map") || url.searchParams.get("id") || "");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    } catch (err) {
      const status = err instanceof PlaybackError ? err.status : 500;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message || "Failed to load playback data." }));
    }
    return;
  }

  if (url.pathname === "/api/icon") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const targetUrl = url.searchParams.get("url") || "";
    if (!targetUrl.startsWith("https://caltopo.com/")) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid icon URL");
      return;
    }
    try {
      const iconRes = await fetch(targetUrl);
      if (!iconRes.ok) {
        res.writeHead(iconRes.status);
        res.end("Icon not found");
        return;
      }
      const buffer = Buffer.from(await iconRes.arrayBuffer());
      res.writeHead(200, { "Content-Type": iconRes.headers.get("content-type") || "image/png" });
      res.end(buffer);
    } catch (e) {
      res.writeHead(502);
      res.end("Proxy error");
    }
    return;
  }

  if (url.pathname === "/api/set-logo" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const { svg } = JSON.parse(body);
        if (svg) {
          writeFileSync("public/favicon.svg", svg.trim() + "\n");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid payload" }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing SVG" }));
    });
    return;
  }

  if (url.pathname === "/logo" || url.pathname === "/logo.html") {
    try {
      const logoPage = readFileSync("public/logo.html");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(logoPage);
      return;
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
  }

  const publicDir = resolve("public");
  const cleanPath = normalize(url.pathname).replace(/^(\.\.[\/\\])+/, "");
  const targetPath = cleanPath === "/" ? resolve("public/index.html") : resolve(publicDir, "." + cleanPath);

  if (!targetPath.startsWith(publicDir)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  const ext = targetPath.slice(targetPath.lastIndexOf("."));
  const contentType = MIME_TYPES[ext] || "text/html; charset=utf-8";

  try {
    const fileContent = readFileSync(targetPath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(fileContent);
  } catch {
    // Fallback to index.html for SPA
    try {
      const indexContent = readFileSync(resolve("public/index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(indexContent);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
});

server.listen(PORT, () => {
  console.log(`Playback dev server running at http://localhost:${PORT}`);
});
