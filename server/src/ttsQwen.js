import WebSocket from "ws";
import crypto from "crypto";

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function generateEventId() {
  if (typeof crypto.randomUUID === "function") {
    return `event_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  return `event_${Date.now()}${Math.random().toString(16).slice(2)}`;
}

export class QwenTTSRealtime {
  constructor({
    apiKey,
    url,
    model,
    voice,
    responseFormat = "pcm",
    sampleRate = 24000,
    mode = "server_commit",
    instructions,
    optimizeInstructions,
    onAudio,
    onSession,
    onError,
    log
  }) {
    this.apiKey = apiKey;
    this.url = url;
    this.model = model;
    this.voice = voice;
    this.responseFormat = responseFormat;
    this.sampleRate = sampleRate;
    this.mode = mode;
    this.instructions = instructions;
    this.optimizeInstructions = optimizeInstructions;
    this.onAudio = onAudio || (() => {});
    this.onSession = onSession || (() => {});
    this.onError = onError || (() => {});
    this.log = log || (() => {});

    this.ws = null;
    this.ready = false;
    this.queue = [];
  }

  async connect() {
    if (!this.apiKey) throw new Error("missing DashScope api key");
    let wsUrl = this.url;
    if (this.model) {
      const u = new URL(this.url);
      u.searchParams.set("model", this.model);
      wsUrl = u.toString();
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    };

    this.ws = new WebSocket(wsUrl, { headers });

    this.ws.on("open", () => {
      this._sendSessionUpdate();
    });

    this.ws.on("message", (data) => {
      const msg = safeJsonParse(data.toString("utf8"));
      if (!msg) return;
      this._handleServerEvent(msg);
    });

    this.ws.on("error", (err) => {
      this.onError(err);
    });

    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  _handleServerEvent(msg) {
    if (!msg?.type) return;
    if (msg.type === "session.created" || msg.type === "session.updated") {
      if (msg.session?.sample_rate) this.sampleRate = msg.session.sample_rate;
      this.ready = true;
      this.onSession(msg.session || {});
      this._flush();
      return;
    }
    if (msg.type === "response.audio.delta") {
      if (msg.delta) this.onAudio(msg.delta, { sampleRate: this.sampleRate, format: this.responseFormat });
      return;
    }
    if (msg.type === "error") {
      const message = msg.error?.message || "tts error";
      this.onError(new Error(message));
    }
  }

  _send(event) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return false;
    this.ws.send(JSON.stringify(event));
    return true;
  }

  _sendSessionUpdate() {
    const session = {
      voice: this.voice,
      mode: this.mode,
      response_format: this.responseFormat,
      sample_rate: this.sampleRate
    };
    if (this.instructions) session.instructions = this.instructions;
    if (this.optimizeInstructions != null) session.optimize_instructions = this.optimizeInstructions;
    this._send({
      event_id: generateEventId(),
      type: "session.update",
      session
    });
  }

  appendText(text) {
    if (!text) return;
    const event = { event_id: generateEventId(), type: "input_text_buffer.append", text };
    if (!this.ready) {
      this.queue.push(event);
      return;
    }
    this._send(event);
  }

  commit() {
    const event = { event_id: generateEventId(), type: "input_text_buffer.commit" };
    if (!this.ready) {
      this.queue.push(event);
      return;
    }
    this._send(event);
  }

  finish() {
    const event = { event_id: generateEventId(), type: "session.finish" };
    this._send(event);
  }

  _flush() {
    if (!this.queue.length) return;
    const items = this.queue.splice(0, this.queue.length);
    items.forEach((ev) => this._send(ev));
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.ready = false;
    this.queue = [];
  }
}