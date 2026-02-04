import { WSClient } from "./wsClient.js";
import { startMic } from "./audio/startMic.js";
import { floatTo16BitPCM, base64FromInt16 } from "./audio/pcm.js";

const transcriptEl = document.getElementById("transcript");
const transcriptLiveEl = document.getElementById("transcriptLive");
const transcriptHistoryEl = document.getElementById("transcriptHistory");
const translatedScriptEl = document.getElementById("translatedScript");
const modelSelect = document.getElementById("modelSelect");
const translationEnabledEl = document.getElementById("translationEnabled");
const translationTargetEl = document.getElementById("translationTarget");
const btnStart = document.getElementById("btnStart");
const btnPause = document.getElementById("btnPause");
const btnStop = document.getElementById("btnStop");
const btnDownloadTranslated = document.getElementById("btnDownloadTranslated");
const translationHint = document.getElementById("translationHint");
const micStatusEl = document.getElementById("micStatus");

const MAX_TRANSCRIPTS = 5;
const transcriptItems = [];
let liveLine = "";
const translatedLines = [];

function renderTranscript() {
  if (transcriptLiveEl) {
    transcriptLiveEl.textContent = liveLine || "Waiting for speech…";
  }
  if (!transcriptHistoryEl) return;
  transcriptHistoryEl.innerHTML = "";
  transcriptItems.forEach((text) => {
    const line = document.createElement("div");
    line.className = "history-item";
    line.textContent = text;
    transcriptHistoryEl.appendChild(line);
  });
}

function updateLiveTranscript(text) {
  if (!text) return;
  liveLine = text;
  renderTranscript();
}

function pushTranscript(text, isFinal) {
  if (!text) return;
  transcriptItems.unshift(text);
  while (transcriptItems.length > MAX_TRANSCRIPTS) transcriptItems.pop();
  if (isFinal) liveLine = "";
  renderTranscript();
}

function renderTranslatedScript() {
  if (!translatedScriptEl) return;
  translatedScriptEl.value = translatedLines.join("\n");
}

function pushTranslatedLine(text) {
  if (!text) return;
  translatedLines.push(text);
  renderTranslatedScript();
}

function downloadTranscript(text, sessionId) {
  if (!text) return;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `transcript-${sessionId || "session"}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

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
let translationSeen = false;

function syncTranslationControls() {
  const model = modelSelect?.value || "";
  const isGummy = model.startsWith("gummy-");
  if (translationEnabledEl) {
    translationEnabledEl.disabled = !isGummy;
    if (!isGummy) translationEnabledEl.checked = false;
  }
  if (translationTargetEl) translationTargetEl.disabled = !isGummy;
  if (translationHint) {
    translationHint.textContent = isGummy
      ? "Gummy supports translation; set a target language."
      : "Fun-ASR is recognition-only and does not translate.";
  }
}

function setMicStatus(message) {
  if (!micStatusEl) return;
  micStatusEl.textContent = message || "";
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random();
}

btnStart.onclick = async () => {
  btnStart.disabled = true;
  syncTranslationControls();
  if (location.protocol !== "https:" && location.hostname !== "localhost") {
    setMicStatus("Microphone requires HTTPS on iPhone. Open the HTTPS URL.");
  } else {
    setMicStatus("Requesting microphone access…");
  }

  paused = false;
  btnPause.textContent = "Pause";

  sessionId = uuid();
  seq = 0;
  transcriptItems.length = 0;
  translatedLines.length = 0;
  translationSeen = false;
  liveLine = "";
  renderTranscript();
  renderTranslatedScript();

  ws = new WSClient(WS_URL, {
    token: TOKEN,
    onOpen: () => {
      if (sessionActive && !sessionStarted) {
        const targetLang = translationTargetEl?.value?.trim();
        ws.send({
          type: "session.start",
          session_id: sessionId,
          format: "pcm16",
          sample_rate: 16000,
          frame_ms: 20,
          translation_enabled: !!translationEnabledEl?.checked,
          translation_target_languages: targetLang ? [targetLang] : [],
          client_ts: Date.now()
        });
        sessionStarted = true;
      }
    },
    onClose: () => {
      if (sessionActive) sessionStarted = false;
    },
    onMessage: (msg) => {
      if (msg.type === "asr.partial") {
        if (!translationSeen) {
          const text = msg.text || "";
          if (text) updateLiveTranscript(text);
        }
        return;
      }
      if (msg.type === "asr.final") {
        if (!translationSeen) {
          const text = msg.text || "";
          if (!text) return;
          pushTranscript(text, true);
          const model = modelSelect?.value || "";
          const isGummy = model.startsWith("gummy-");
          if (!translationEnabledEl?.checked || !isGummy) {
            pushTranslatedLine(text);
          }
        }
        return;
      }
      if (msg.type === "asr.translation.partial") {
        const label = msg.lang ? `Translation (${msg.lang}): ` : "Translation: ";
        const text = msg.text || "";
        if (text) updateLiveTranscript(label + text);
        return;
      }
      if (msg.type === "asr.translation.final") {
        const label = msg.lang ? `Translation (${msg.lang}): ` : "Translation: ";
        const text = msg.text || "";
        if (!text) return;
        translationSeen = true;
        pushTranscript(label + text, true);
        pushTranslatedLine(text);
      }
    }
  });

  await ws.connect();

  const sendSessionStart = () => {
    if (sessionStarted) return;
    const targetLang = translationTargetEl?.value?.trim();
    ws.send({
      type: "session.start",
      session_id: sessionId,
      format: "pcm16",
      sample_rate: 16000,
      frame_ms: 20,
      model: modelSelect?.value || undefined,
      translation_enabled: !!translationEnabledEl?.checked,
      translation_target_languages: targetLang ? [targetLang] : [],
      client_ts: Date.now()
    });
    sessionStarted = true;
  };

  sendSessionStart();

  try {
    mic = await startMic({
      dstRate: 16000,
      frameMs: 20,
      requestTimeoutMs: 15000,
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
    setMicStatus("Microphone active.");
  } catch (err) {
    const name = err?.name || "Error";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      setMicStatus("Microphone permission denied. Check iOS Settings > Safari > Microphone.");
    } else if (String(err?.message || "").includes("timed out")) {
      setMicStatus("Microphone permission prompt timed out. Tap Start again and allow access.");
    } else if (location.protocol !== "https:") {
      setMicStatus("Microphone requires HTTPS on iPhone. Open the HTTPS URL.");
    } else {
      setMicStatus(`Microphone error: ${err?.message || err}`);
    }
    btnStart.disabled = false;
    return;
  }

  sessionActive = true;
  btnPause.disabled = false;
  btnStop.disabled = false;
  renderTranscript();
};

modelSelect?.addEventListener("change", syncTranslationControls);
syncTranslationControls();

btnPause.onclick = async () => {
  if (!sessionActive) return;
  if (!paused) {
    paused = true;
    btnPause.textContent = "Resume";
    await mic?.stop();
    mic = null;
    return;
  }

  paused = false;
  btnPause.textContent = "Pause";
  mic = await startMic({
    dstRate: 16000,
    frameMs: 20,
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
  setMicStatus("");
};

btnDownloadTranslated?.addEventListener("click", () => {
  downloadTranscript(translatedLines.join("\n"), `${sessionId || "session"}-translated`);
});

document.addEventListener("visibilitychange", () => {
  if (!mic?.audioCtx) return;
  if (!document.hidden) {
    mic.audioCtx.resume().catch(() => {});
  }
});
