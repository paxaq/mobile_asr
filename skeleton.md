Below is a **practical technical plan + code skeleton** for:

* **Mobile Web (iPhone Safari)**: `getUserMedia` → `AudioWorklet` → **downsample to 16k** → **PCM16 frames** → **WebSocket (WSS)** to your server
* **Backend (Node.js)**: `ws` server → authenticate → receive frames → reorder/buffer → (a) forward to ASR worker / (b) write to WAV/PCM / (c) broadcast partial transcripts back

Everything is organized so you can implement incrementally.

---

# 1) Protocol (WS messages)

### Client → Server

```json
{ "type": "session.start", "session_id": "uuid", "format": "pcm16", "sample_rate": 16000, "frame_ms": 20, "client_ts": 1710000000000 }

{ "type": "audio.frame", "session_id": "uuid", "seq": 123, "client_ts": 1710000000123, "audio_b64": "...." }

{ "type": "session.stop", "session_id": "uuid", "client_ts": 1710000009999 }
```

### Server → Client (optional)

```json
{ "type": "asr.partial", "session_id": "uuid", "text": "你好..." }
{ "type": "asr.final",   "session_id": "uuid", "text": "你好，今天..." }
{ "type": "server.info", "session_id": "uuid", "message": "connected" }
{ "type": "server.error","session_id": "uuid", "code": "AUTH_FAILED", "message": "..." }
```

---

# 2) Web Frontend technical plan (AudioWorklet + WS)

## 2.1 Key Safari constraints you must handle

* Mic capture must be started by **user gesture** (tap button).
* iOS may **suspend** audio when page goes background; you must listen for `visibilitychange` and attempt `audioContext.resume()` on user gesture.
* Default device sample rate is often 48k/44.1k → you must **downsample** to 16k.

## 2.2 Frame format choice (v1)

* **PCM16, 16kHz, mono**, 20ms frames (320 samples → 640 bytes)
* Encode as base64 to keep WS payload simple (binary WS is faster; you can switch later)

---

# 3) Frontend code structure

### Suggested folder layout

```
web/
  index.html
  src/
    main.js
    wsClient.js
    audio/
      startMic.js
      pcm.js
      worklet/
        pcm-worklet.js
```

## 3.1 `index.html` (minimal UI)

```html
<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body>
  <button id="btnStart">Start</button>
  <button id="btnStop" disabled>Stop</button>
  <pre id="log"></pre>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
```

## 3.2 `src/wsClient.js` (WS + reconnect + send helpers)

```js
export class WSClient {
  constructor(url, { token, onMessage, onOpen, onClose, log } = {}) {
    this.url = url;
    this.token = token;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.log = log || (() => {});
    this.ws = null;

    this.backoffMs = 500;
    this.maxBackoffMs = 5000;
    this.shouldReconnect = true;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      if (this.token) u.searchParams.set("token", this.token); // simplest auth for web
      this.ws = new WebSocket(u.toString());
      this.ws.onopen = () => {
        this.backoffMs = 500;
        this.onOpen?.();
        resolve();
      };
      this.ws.onclose = () => {
        this.onClose?.();
        if (this.shouldReconnect) this._reconnect();
      };
      this.ws.onerror = (e) => {
        this.log("ws error", e);
      };
      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          this.onMessage?.(msg);
        } catch {
          this.log("bad msg", ev.data);
        }
      };
    });
  }

  _reconnect() {
    setTimeout(() => {
      if (!this.shouldReconnect) return;
      this.connect().catch(() => {});
      this.backoffMs = Math.min(this.maxBackoffMs, Math.floor(this.backoffMs * 1.5));
    }, this.backoffMs);
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  close() {
    this.shouldReconnect = false;
    this.ws?.close();
  }
}
```

## 3.3 `src/audio/pcm.js` (Float32 → PCM16, base64)

```js
export function floatTo16BitPCM(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function base64FromInt16(int16) {
  // Convert Int16Array to base64
  const u8 = new Uint8Array(int16.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}
```

## 3.4 `src/audio/worklet/pcm-worklet.js` (AudioWorkletProcessor)

This worklet:

* receives float32 audio at device sample rate
* does **linear downsample** to 16k
* posts **20ms Float32 frames** back to main thread

```js
class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = options?.processorOptions || {};
    this.srcRate = sampleRate;          // provided by AudioWorklet global
    this.dstRate = p.dstRate || 16000;
    this.frameSamples = p.frameSamples || 320; // 20ms @ 16k
    this._buffer = new Float32Array(0);
  }

  _downsampleLinear(input) {
    if (this.srcRate === this.dstRate) return input;

    const ratio = this.dstRate / this.srcRate;
    const outLen = Math.floor(input.length * ratio);
    if (outLen <= 0) return new Float32Array(0);

    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i / ratio;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const a = input[idx] || 0;
      const b = input[idx + 1] || a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  _append(buf) {
    const merged = new Float32Array(this._buffer.length + buf.length);
    merged.set(this._buffer, 0);
    merged.set(buf, this._buffer.length);
    this._buffer = merged;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const mono = input[0]; // Float32Array
    const ds = this._downsampleLinear(mono);
    if (ds.length === 0) return true;

    this._append(ds);

    while (this._buffer.length >= this.frameSamples) {
      const frame = this._buffer.slice(0, this.frameSamples);
      this._buffer = this._buffer.slice(this.frameSamples);
      this.port.postMessage({ type: "audio.frame", frame });
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
```

## 3.5 `src/audio/startMic.js` (setup getUserMedia + Worklet)

```js
export async function startMic({ onFrame, dstRate = 16000, frameMs = 20, log }) {
  log ||= (() => {});
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.audioWorklet.addModule("/src/audio/worklet/pcm-worklet.js");

  const source = audioCtx.createMediaStreamSource(stream);

  const frameSamples = Math.round(dstRate * frameMs / 1000);

  const worklet = new AudioWorkletNode(audioCtx, "pcm-worklet", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    processorOptions: { dstRate, frameSamples }
  });

  worklet.port.onmessage = (ev) => {
    const msg = ev.data;
    if (msg?.type === "audio.frame") onFrame(msg.frame);
  };

  source.connect(worklet);

  return {
    audioCtx,
    stream,
    stop: async () => {
      try { worklet.disconnect(); } catch {}
      try { source.disconnect(); } catch {}
      stream.getTracks().forEach(t => t.stop());
      await audioCtx.close();
    }
  };
}
```

## 3.6 `src/main.js` (wire UI → mic → WS)

```js
import { WSClient } from "./wsClient.js";
import { startMic } from "./audio/startMic.js";
import { floatTo16BitPCM, base64FromInt16 } from "./audio/pcm.js";

const logEl = document.getElementById("log");
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");

const log = (...a) => (logEl.textContent += a.join(" ") + "\n");

const WS_URL = "wss://YOUR_DOMAIN/ws/audio"; // your node server
const TOKEN = "YOUR_JWT_OR_TEMP_TOKEN";      // ideally fetched from your server

let sessionId = null;
let seq = 0;
let ws = null;
let mic = null;

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random();
}

btnStart.onclick = async () => {
  btnStart.disabled = true;

  sessionId = uuid();
  seq = 0;

  ws = new WSClient(WS_URL, {
    token: TOKEN,
    log,
    onOpen: () => log("[ws] open"),
    onClose: () => log("[ws] close"),
    onMessage: (msg) => {
      if (msg.type?.startsWith("asr.")) log(`[${msg.type}]`, msg.text || "");
      if (msg.type === "server.error") log("[err]", msg.code, msg.message);
    }
  });

  await ws.connect();

  ws.send({
    type: "session.start",
    session_id: sessionId,
    format: "pcm16",
    sample_rate: 16000,
    frame_ms: 20,
    client_ts: Date.now()
  });

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

  btnStop.disabled = false;
  log("[mic] started");
};

btnStop.onclick = async () => {
  btnStop.disabled = true;

  ws?.send({ type: "session.stop", session_id: sessionId, client_ts: Date.now() });
  await mic?.stop();

  ws?.close();
  mic = null;
  ws = null;

  btnStart.disabled = false;
  log("[mic] stopped");
};

// iOS Safari: if page hidden, audio may suspend
document.addEventListener("visibilitychange", () => {
  if (!mic?.audioCtx) return;
  if (!document.hidden) {
    // resume requires user gesture sometimes; still try
    mic.audioCtx.resume().catch(() => {});
  }
});
```

---

# 4) Node backend technical plan (WS ingest)

## 4.1 Key responsibilities

1. TLS termination (via your reverse proxy like Nginx/Cloudflare) → Node sees WS
2. Auth (token in query or `Sec-WebSocket-Protocol`)
3. Per-session state: `expectedSeq`, small reordering buffer
4. Downstream:

   * MVP: write PCM to file per session
   * Next: forward PCM to ASR worker and push transcripts back to client

---

# 5) Node backend skeleton (`ws`)

### Folder layout

```
server/
  package.json
  src/
    index.js
    auth.js
    sessions.js
    wavWriter.js
```

## 5.1 `package.json`

```json
{
  "name": "audio-ingest",
  "type": "module",
  "dependencies": {
    "ws": "^8.16.0",
    "uuid": "^9.0.1"
  }
}
```

## 5.2 `src/auth.js` (simple token check placeholder)

```js
export function verifyToken(token) {
  // TODO: replace with JWT verify or your auth service
  if (!token) return { ok: false, reason: "missing token" };
  if (token.length < 10) return { ok: false, reason: "bad token" };
  return { ok: true, userId: "demo-user" };
}
```

## 5.3 `src/wavWriter.js` (optional: write PCM16 to WAV)

```js
import fs from "fs";

export function createWavWriter(path, sampleRate = 16000, channels = 1) {
  const fd = fs.openSync(path, "w");
  let dataBytes = 0;

  // Write placeholder header (44 bytes)
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4); // will patch
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(0, 40); // will patch

  fs.writeSync(fd, header);

  function writePcm(pcmBuf) {
    fs.writeSync(fd, pcmBuf);
    dataBytes += pcmBuf.length;
  }

  function close() {
    // Patch sizes
    const riffSize = 36 + dataBytes;
    const dataSize = dataBytes;

    const patch = Buffer.alloc(8);
    patch.writeUInt32LE(riffSize, 0);
    fs.writeSync(fd, patch, 0, 4, 4);

    patch.writeUInt32LE(dataSize, 0);
    fs.writeSync(fd, patch, 0, 4, 40);

    fs.closeSync(fd);
  }

  return { writePcm, close };
}
```

## 5.4 `src/sessions.js` (seq reorder + buffering)

```js
import { createWavWriter } from "./wavWriter.js";

export class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> state
  }

  start(sessionId, { sampleRate = 16000 } = {}) {
    const wav = createWavWriter(`./recordings/${sessionId}.wav`, sampleRate, 1);
    const st = {
      expectedSeq: 0,
      buffer: new Map(),   // seq -> Buffer
      maxReorder: 50,      // tolerate up to 50 frames reorder
      wav,
      sampleRate
    };
    this.sessions.set(sessionId, st);
    return st;
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  stop(sessionId) {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    st.wav.close();
    this.sessions.delete(sessionId);
  }

  pushFrame(sessionId, seq, pcmBuf) {
    const st = this.sessions.get(sessionId);
    if (!st) return { ok: false, reason: "no session" };

    if (seq < st.expectedSeq) {
      // late duplicate; drop
      return { ok: true, dropped: true };
    }

    st.buffer.set(seq, pcmBuf);

    // prevent unbounded buffer
    if (st.buffer.size > st.maxReorder) {
      // drop oldest beyond window
      const minSeq = Math.min(...st.buffer.keys());
      st.buffer.delete(minSeq);
    }

    // flush in order
    while (st.buffer.has(st.expectedSeq)) {
      const b = st.buffer.get(st.expectedSeq);
      st.buffer.delete(st.expectedSeq);
      st.wav.writePcm(b);
      st.expectedSeq++;
      // TODO: feed ASR worker here in-order
    }

    return { ok: true };
  }
}
```

## 5.5 `src/index.js` (WS server)

```js
import http from "http";
import fs from "fs";
import { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import { SessionManager } from "./sessions.js";

fs.mkdirSync("./recordings", { recursive: true });

const server = http.createServer();
const wss = new WebSocketServer({ server, path: "/ws/audio" });

const sessions = new SessionManager();

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
      if (sessions.has(msg.session_id)) {
        send(ws, { type: "server.error", code: "DUP_SESSION", message: "session exists" });
        return;
      }
      sessions.start(msg.session_id, { sampleRate: msg.sample_rate || 16000 });
      send(ws, { type: "server.info", session_id: msg.session_id, message: "session started" });
      return;
    }

    if (msg.type === "audio.frame") {
      const { session_id, seq, audio_b64 } = msg;
      if (!session_id || typeof seq !== "number" || !audio_b64) return;

      const pcmBuf = Buffer.from(audio_b64, "base64"); // PCM16LE bytes
      sessions.pushFrame(session_id, seq, pcmBuf);
      return;
    }

    if (msg.type === "session.stop") {
      if (msg.session_id) sessions.stop(msg.session_id);
      send(ws, { type: "server.info", session_id: msg.session_id, message: "session stopped" });
      return;
    }
  });

  ws.on("close", () => {
    // Optional: you can end all sessions associated with this ws
  });
});

server.listen(8080, () => {
  console.log("WS ingest listening on :8080 (path /ws/audio)");
});
```

Run:

```bash
cd server
npm i
node src/index.js
```

---

# 6) Reverse proxy (required for iPhone Safari)

You’ll typically expose:

* `https://yourdomain/` (web frontend)
* `wss://yourdomain/ws/audio` (WS to Node)

If you use Nginx, ensure WS upgrade headers and long timeouts.

---

# 7) What to implement next (in order)

1. **MVP**: Web sends frames, Node writes `recordings/<session>.wav`
2. Add **server→client** pings + keepalive + better reconnect semantics
3. Integrate ASR worker:

   * feed PCM chunks as they flush in order
   * stream partial/final transcripts back via `ws.send({type:"asr.partial"...})`
4. Switch to **binary frames** to reduce base64 overhead (optional)

-