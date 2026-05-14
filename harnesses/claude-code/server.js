// Minimal bridge: serves a static xterm.js page on /, accepts WebSocket
// upgrades on /tty, and pipes bytes between the browser terminal and a
// real PTY running the configured command (default: `claude`).
//
// Protocol on /tty:
//   browser -> server : raw text (keystrokes)  OR  JSON {"type":"resize","cols":N,"rows":M}
//   server  -> browser: raw bytes (PTY stdout)
//
// Override the command for testing without an API key:
//   POC_CMD=bash docker run …

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4096);
const CMD = process.env.POC_CMD ?? "claude";
const REPO_DIR = process.env.REPO_DIR ?? process.cwd();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
};

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, cmd: CMD, repo: REPO_DIR }));
    return;
  }
  // Serve the static page on /
  const url = req.url === "/" ? "/index.html" : req.url;
  const file = path.join(__dirname, "public", url.replace(/\?.*$/, ""));
  if (!file.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/tty" });

wss.on("connection", (ws) => {
  let term;
  try {
    term = pty.spawn(CMD, [], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: REPO_DIR,
      env: process.env,
    });
  } catch (e) {
    ws.send(`\r\n\x1b[31m[bridge] failed to spawn ${CMD}: ${e.message}\x1b[0m\r\n`);
    ws.close();
    return;
  }

  console.log(`[bridge] spawned ${CMD} (pid ${term.pid}) for ${ws._socket.remoteAddress}`);

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  term.onExit(({ exitCode, signal }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[2m[bridge] process exited (code=${exitCode}, signal=${signal ?? "-"})\x1b[0m\r\n`);
      ws.close();
    }
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) { term.write(raw); return; }
    const s = raw.toString();
    // Resize messages are the only JSON we accept; everything else is
    // keystrokes. The startsWith check keeps the hot path cheap.
    if (s.length > 0 && s[0] === "{") {
      try {
        const msg = JSON.parse(s);
        if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          term.resize(msg.cols, msg.rows);
          return;
        }
      } catch { /* fall through and treat as keystrokes */ }
    }
    term.write(s);
  });

  ws.on("close", () => {
    try { term.kill(); } catch { /* already gone */ }
  });

  ws.on("error", (e) => console.warn(`[bridge] ws error: ${e.message}`));
});

server.listen(PORT, () => {
  console.log(`[bridge] listening on http://0.0.0.0:${PORT}  (cmd=${CMD}, cwd=${REPO_DIR})`);
});
