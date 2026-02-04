import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { SessionManager } from "./sessions.js";
import { DashScopeASR } from "./asrDashscope.js";
import { config } from "./config.js";

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
const asrSessions = new Map(); // sessionId -> DashScopeASR

const DEBUG = config.debug.asr;
function debugLog(...args) {
  if (DEBUG) console.log("[debug]", ...args);
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  debugLog("ws connected", { ip: req.socket?.remoteAddress });

  const v = verifyToken(token);
  if (!v.ok) {
    send(ws, { type: "server.error", code: "AUTH_FAILED", message: v.reason });
    ws.close();
    return;
  }

  debugLog("auth ok");

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

    debugLog("ws message", msg?.type);

    if (msg.type === "session.start") {
      if (!msg.session_id) {
        send(ws, { type: "server.error", code: "BAD_SESSION", message: "missing session_id" });
        return;
      }
      const existed = sessions.has(msg.session_id);
      sessions.start(msg.session_id, { sampleRate: msg.sample_rate || 16000, frameMs: msg.frame_ms || 20 });
      debugLog("session.start", { session_id: msg.session_id, existed, model: msg.model });
      send(ws, {
        type: "server.info",
        session_id: msg.session_id,
        message: existed ? "session resumed" : "session started"
      });

      if (!asrSessions.has(msg.session_id)) {
        const allowModels = config.dashscope.allowModels;
        const requestedModel = msg.model;
        const model = allowModels.has(requestedModel)
          ? requestedModel
          : config.dashscope.defaultModel;
        const isInference = model.startsWith("fun-asr-") || model.startsWith("gummy-");
        const url = isInference ? config.dashscope.urlInference : config.dashscope.urlRealtime;
        const translationEnabledEnv = config.dashscope.translation.enabled;
        const translationTargetLanguages = config.dashscope.translation.targetLanguages;
        const sourceLanguage = config.dashscope.sourceLanguage || null;
        const clientTranslationEnabled = msg.translation_enabled === undefined
          ? null
          : Boolean(msg.translation_enabled);
        const clientTargetLanguages = Array.isArray(msg.translation_target_languages)
          ? msg.translation_target_languages.map((item) => String(item).trim()).filter(Boolean)
          : [];
        const translationEnabled = model.startsWith("gummy-")
          && (clientTranslationEnabled ?? translationEnabledEnv);
        const effectiveTargetLanguages = (clientTargetLanguages.length > 0
          ? clientTargetLanguages
          : translationTargetLanguages).slice(0, 1);
        const finalTranslationEnabled = translationEnabled && effectiveTargetLanguages.length > 0;
        debugLog("asr init", {
          model,
          isInference,
          url,
          translationEnabled: finalTranslationEnabled,
          translationTargetLanguages: effectiveTargetLanguages
        });
        const asr = new DashScopeASR({
          apiKey: config.dashscope.apiKey,
          url,
          model,
          protocol: isInference ? "inference" : "realtime",
          sampleRate: msg.sample_rate || 16000,
          format: "pcm",
          language: config.dashscope.language || "zh",
          sourceLanguage,
          transcriptionEnabled: true,
          translationEnabled: finalTranslationEnabled,
          translationTargetLanguages: finalTranslationEnabled ? effectiveTargetLanguages : [],
          enableServerVad: config.dashscope.vad.enabled,
          vadSilenceMs: config.dashscope.vad.silenceMs,
          vadThreshold: config.dashscope.vad.threshold,
          funAsrSemanticPunctuationEnabled: config.dashscope.funAsr.semanticPunctuationEnabled,
          funAsrMaxSentenceSilenceMs: config.dashscope.funAsr.maxSentenceSilenceMs,
          funAsrMultiThresholdModeEnabled: config.dashscope.funAsr.multiThresholdModeEnabled,
          sessionUpdateTemplate: config.dashscope.sessionUpdateTemplate,
          onPartial: (text) => {
            send(ws, { type: "asr.partial", session_id: msg.session_id, text });
          },
          onFinal: (text) => {
            send(ws, { type: "asr.final", session_id: msg.session_id, text });
          },
          onTranslationPartial: (text, lang) => {
            send(ws, { type: "asr.translation.partial", session_id: msg.session_id, text, lang });
          },
          onTranslationFinal: (text, lang) => {
            send(ws, { type: "asr.translation.final", session_id: msg.session_id, text, lang });
          },
          onError: (err) => {
            send(ws, { type: "server.error", code: "ASR_ERROR", message: String(err?.message || err) });
          }
        });

        asr.connect().catch((err) => {
          send(ws, { type: "server.error", code: "ASR_CONNECT_FAILED", message: String(err?.message || err) });
        });

        asrSessions.set(msg.session_id, asr);
      }
      return;
    }

    if (msg.type === "audio.frame") {
      const { session_id, seq, audio_b64 } = msg;
      if (!session_id || typeof seq !== "number" || !audio_b64) return;

      const pcmBuf = Buffer.from(audio_b64, "base64");
      const r = sessions.pushFrame(session_id, seq, pcmBuf);
      if (!r.ok) {
        send(ws, { type: "server.error", code: "BAD_FRAME", message: r.reason, details: r });
        return;
      }
      if (seq % 50 === 0) debugLog("audio.frame", { session_id, seq, bytes: pcmBuf.length });
      const asr = asrSessions.get(session_id);
      asr?.sendAudio(pcmBuf);
      return;
    }

    if (msg.type === "session.stop") {
      if (msg.session_id) sessions.stop(msg.session_id);
      const asr = asrSessions.get(msg.session_id);
      asr?.finish();
      setTimeout(() => asr?.stop(), 500);
      asrSessions.delete(msg.session_id);
      debugLog("session.stop", { session_id: msg.session_id });
      send(ws, { type: "server.info", session_id: msg.session_id, message: "session stopped" });
      return;
    }
  });

  ws.on("close", () => {
    clearInterval(pingTimer);
    debugLog("ws closed");
  });
});

const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  console.log(`Server listening on :${port} (static + WS path /ws/audio)`);
});
