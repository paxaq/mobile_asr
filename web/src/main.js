import { WSClient } from "./wsClient.js";
import { startMic } from "./audio/startMic.js";
import { floatTo16BitPCM, base64FromInt16 } from "./audio/pcm.js";

const logEl = document.getElementById("log");
const btnStart = document.getElementById("btnStart");
const btnPause = document.getElementById("btnPause");
const btnStop = document.getElementById("btnStop");

const log = (...a) => (logEl.textContent += a.join(" ") + "\n");

const params = new URLSearchParams(window.location.search);
const WS_URL = params.get("ws") || (() => {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/audio`;
})();
const TOKEN = params.get("token") || "dev-token-12345";

let sessionId = null;
let seq = 0;
let ws = null;
let mic = null;
let sessionActive = false;
let sessionStarted = false;
let paused = false;

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random();
}

btnStart.onclick = async () => {
  btnStart.disabled = true;

  paused = false;
  btnPause.textContent = "Pause";

  sessionId = uuid();
  seq = 0;

  ws = new WSClient(WS_URL, {
    token: TOKEN,
    log,
    onOpen: () => {
      log("[ws] open");
      if (sessionActive && !sessionStarted) {
        ws.send({
          type: "session.start",
          session_id: sessionId,
          format: "pcm16",
          sample_rate: 16000,
          frame_ms: 20,
          client_ts: Date.now()
        });
        sessionStarted = true;
      }
    },
    onClose: () => {
      log("[ws] close");
      if (sessionActive) sessionStarted = false;
    },
    onMessage: (msg) => {
      if (msg.type?.startsWith("asr.")) log(`[${msg.type}]`, msg.text || "");
      if (msg.type === "server.error") log("[err]", msg.code, msg.message);
    }
  });

  await ws.connect();

  const sendSessionStart = () => {
    if (sessionStarted) return;
    ws.send({
      type: "session.start",
      session_id: sessionId,
      format: "pcm16",
      sample_rate: 16000,
      frame_ms: 20,
      client_ts: Date.now()
    });
    sessionStarted = true;
  };

  sendSessionStart();

  mic = await startMic({
    dstRate: 16000,
    frameMs: 20,
    log,
    onFrame: (floatFrame) => {
      const pcm16 = floatTo16BitPCM(floatFrame);
      const b64 = base64FromInt16(pcm16);

      ws.send({
        type: "audio.frame",
        session_id: sessionId,
        seq: seq++,
        client_ts: Date.now(),
        audio_b64: b64
      });
    }
  });

  sessionActive = true;
  btnPause.disabled = false;
  btnStop.disabled = false;
  log("[mic] started");
};

btnPause.onclick = async () => {
  if (!sessionActive) return;
  if (!paused) {
    paused = true;
    btnPause.textContent = "Resume";
    await mic?.stop();
    mic = null;
    log("[mic] paused");
    return;
  }

  paused = false;
  btnPause.textContent = "Pause";
  mic = await startMic({
    dstRate: 16000,
    frameMs: 20,
    log,
    onFrame: (floatFrame) => {
      const pcm16 = floatTo16BitPCM(floatFrame);
      const b64 = base64FromInt16(pcm16);

      ws?.send({
        type: "audio.frame",
        session_id: sessionId,
        seq: seq++,
        client_ts: Date.now(),
        audio_b64: b64
      });
    }
  });
  log("[mic] resumed");
};

btnStop.onclick = async () => {
  btnStop.disabled = true;
  btnPause.disabled = true;

  ws?.send({ type: "session.stop", session_id: sessionId, client_ts: Date.now() });
  await mic?.stop();

  ws?.close();
  mic = null;
  ws = null;

  sessionActive = false;
  sessionStarted = false;
  btnStart.disabled = false;
  btnPause.textContent = "Pause";
  log("[mic] stopped");
};

document.addEventListener("visibilitychange", () => {
  if (!mic?.audioCtx) return;
  if (!document.hidden) {
    mic.audioCtx.resume().catch(() => {});
  }
});
