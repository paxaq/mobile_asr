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
const ttsEnabledEl = document.getElementById("ttsEnabled");
const ttsModelEl = document.getElementById("ttsModel");
const ttsVoiceEl = document.getElementById("ttsVoice");
const btnStart = document.getElementById("btnStart");
const btnPause = document.getElementById("btnPause");
const btnStop = document.getElementById("btnStop");
const btnDownloadTranslated = document.getElementById("btnDownloadTranslated");
const btnTranscriptFontDown = document.getElementById("btnTranscriptFontDown");
const btnTranscriptFontUp = document.getElementById("btnTranscriptFontUp");
const btnTranslatedFontDown = document.getElementById("btnTranslatedFontDown");
const btnTranslatedFontUp = document.getElementById("btnTranslatedFontUp");
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
  transcriptItems.forEach((text, index) => {
    const line = document.createElement("div");
    line.className = "history-item";
    line.textContent = text;
    if (index === 0) {
      line.style.fontWeight = "700";
      line.style.fontSize = "1.1em";
    }
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

function adjustFontSize(el, delta, { min = 11, max = 28 } = {}) {
  if (!el) return;
  const current = Number.parseFloat(getComputedStyle(el).fontSize) || 14;
  const next = Math.min(max, Math.max(min, current + delta));
  el.style.fontSize = `${next}px`;
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
let ttsQueue = [];
let ttsSpeaking = false;
let ttsPartialText = "";
let ttsAudioPlayer = null;
let ttsSampleRate = 24000;

class PcmPlayer {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    this.nextStartTime = this.ctx.currentTime;
  }

  async resume() {
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch {}
    }
  }

  enqueue(int16) {
    if (!int16?.length) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = Math.max(-1, Math.min(1, int16[i] / 32768));
    }
    const buffer = this.ctx.createBuffer(1, float32.length, this.sampleRate);
    buffer.getChannelData(0).set(float32);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.nextStartTime, this.ctx.currentTime + 0.02);
    src.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  reset() {
    this.nextStartTime = this.ctx.currentTime;
  }

  async close() {
    try { await this.ctx.close(); } catch {}
  }
}

function b64ToInt16(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const buf = new ArrayBuffer(len);
  const view = new Uint8Array(buf);
  for (let i = 0; i < len; i++) view[i] = binary.charCodeAt(i);
  return new Int16Array(buf);
}

function ensureTtsPlayer(sampleRate) {
  if (!ttsAudioPlayer || ttsSampleRate !== sampleRate) {
    ttsSampleRate = sampleRate;
    ttsAudioPlayer?.close();
    ttsAudioPlayer = new PcmPlayer(sampleRate);
  }
  ttsAudioPlayer.resume();
  return ttsAudioPlayer;
}

function useServerTts() {
  const ttsModel = ttsModelEl?.value || "";
  const asrModel = modelSelect?.value || "";
  const isGummy = asrModel.startsWith("gummy-");
  return !!ttsEnabledEl?.checked && ttsModel && ttsModel !== "browser-tts" && isGummy;
}

function sendTtsEvent(wsClient, payload) {
  if (!wsClient) return;
  wsClient.send(payload);
}

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

function mapLang(code) {
  const v = (code || "").toLowerCase();
  const map = {
    en: "en-US",
    zh: "zh-CN",
    ja: "ja-JP",
    ko: "ko-KR",
    fr: "fr-FR",
    de: "de-DE",
    es: "es-ES",
    ru: "ru-RU",
    it: "it-IT",
    pt: "pt-PT",
    id: "id-ID",
    ar: "ar-SA",
    th: "th-TH",
    vi: "vi-VN",
    nl: "nl-NL",
    da: "da-DK",
    hi: "hi-IN",
    yue: "zh-HK",
    ms: "ms-MY",
    ur: "ur-PK",
    tr: "tr-TR"
  };
  return map[v] || navigator.language || "en-US";
}

function enqueueTts(text, lang) {
  if (!text || !ttsEnabledEl?.checked) return;
  ttsQueue.push({ text, lang });
  if (!ttsSpeaking) playNextTts();
}

function playNextTts() {
  const item = ttsQueue.shift();
  if (!item) {
    ttsSpeaking = false;
    return;
  }

  if (!("speechSynthesis" in window)) {
    ttsSpeaking = false;
    return;
  }

  ttsSpeaking = true;
  const utter = new SpeechSynthesisUtterance(item.text);
  utter.lang = mapLang(item.lang);
  utter.onend = () => playNextTts();
  utter.onerror = () => playNextTts();
  window.speechSynthesis.speak(utter);
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
  ttsQueue = [];
  ttsSpeaking = false;
  ttsPartialText = "";
  if (useServerTts()) {
    ensureTtsPlayer(ttsSampleRate).reset();
  } else {
    ttsAudioPlayer?.reset();
  }
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
            if (useServerTts()) {
              sendTtsEvent(ws, { type: "tts.append", session_id: sessionId, text });
              sendTtsEvent(ws, { type: "tts.commit", session_id: sessionId });
            } else {
              enqueueTts(text, translationTargetEl?.value?.trim() || "en");
            }
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
        if (useServerTts()) {
          ttsPartialText = "";
          sendTtsEvent(ws, { type: "tts.append", session_id: sessionId, text });
          sendTtsEvent(ws, { type: "tts.commit", session_id: sessionId });
        } else {
          enqueueTts(text, msg.lang || translationTargetEl?.value?.trim() || "en");
        }
        return;
      }

      if (msg.type === "tts.session") {
        if (msg.sample_rate) ttsSampleRate = msg.sample_rate;
        return;
      }

      if (msg.type === "tts.audio.delta") {
        if (!useServerTts()) return;
        const sampleRate = msg.sample_rate || ttsSampleRate || 24000;
        const int16 = b64ToInt16(msg.audio_b64 || "");
        ensureTtsPlayer(sampleRate).enqueue(int16);
        return;
      }

      if (msg.type === "tts.error") {
        console.warn("TTS error:", msg.message);
        return;
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
    if (useServerTts()) {
      ws.send({
        type: "tts.start",
        session_id: sessionId,
        model: ttsModelEl?.value || undefined,
        voice: ttsVoiceEl?.value || undefined,
        sample_rate: ttsSampleRate
      });
    }
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

btnTranscriptFontDown?.addEventListener("click", () => adjustFontSize(transcriptEl, -1));
btnTranscriptFontUp?.addEventListener("click", () => adjustFontSize(transcriptEl, 1));
btnTranslatedFontDown?.addEventListener("click", () => adjustFontSize(translatedScriptEl, -1));
btnTranslatedFontUp?.addEventListener("click", () => adjustFontSize(translatedScriptEl, 1));

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
  if (useServerTts()) {
    ws?.send({ type: "tts.finish", session_id: sessionId });
  }
  await mic?.stop();

  ws?.close();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  if (useServerTts()) {
    await ttsAudioPlayer?.close();
    ttsAudioPlayer = null;
  } else {
    ttsAudioPlayer?.reset();
  }
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
