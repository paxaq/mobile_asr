import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { SessionManager } from "./sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(__dirname, "..", "..", "web");
const recordingsDir = path.resolve(__dirname, "..", "recordings");
fs.mkdirSync(recordingsDir, { recursive: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const resolved = path.resolve(staticRoot, pathname.slice(1));
  if (!resolved.startsWith(staticRoot)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const type = ext === ".html" ? "text/html" :
      ext === ".js" ? "text/javascript" :
      ext === ".css" ? "text/css" :
      ext === ".svg" ? "image/svg+xml" :
      "application/octet-stream";

    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, path: "/ws/audio" });

const sessions = new SessionManager({ recordingsDir });

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  const v = verifyToken(token);
  if (!v.ok) {
    send(ws, { type: "server.error", code: "AUTH_FAILED", message: v.reason });
    ws.close();
    return;
  }

  send(ws, { type: "server.info", message: "connected" });

  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 10000);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      send(ws, { type: "server.error", code: "BAD_JSON", message: "invalid json" });
      return;
    }

    if (msg.type === "session.start") {
      if (!msg.session_id) {
        send(ws, { type: "server.error", code: "BAD_SESSION", message: "missing session_id" });
        return;
      }
      const existed = sessions.has(msg.session_id);
      sessions.start(msg.session_id, { sampleRate: msg.sample_rate || 16000, frameMs: msg.frame_ms || 20 });
      send(ws, {
        type: "server.info",
        session_id: msg.session_id,
        message: existed ? "session resumed" : "session started"
      });
      return;
    }

    if (msg.type === "audio.frame") {
      const { session_id, seq, audio_b64 } = msg;
      if (!session_id || typeof seq !== "number" || !audio_b64) return;

      const pcmBuf = Buffer.from(audio_b64, "base64");
      const r = sessions.pushFrame(session_id, seq, pcmBuf);
      if (!r.ok) {
        send(ws, { type: "server.error", code: "BAD_FRAME", message: r.reason, details: r });
      }
      return;
    }

    if (msg.type === "session.stop") {
      if (msg.session_id) sessions.stop(msg.session_id);
      send(ws, { type: "server.info", session_id: msg.session_id, message: "session stopped" });
      return;
    }
  });

  ws.on("close", () => {
    clearInterval(pingTimer);
  });
});

const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  console.log(`Server listening on :${port} (static + WS path /ws/audio)`);
});
