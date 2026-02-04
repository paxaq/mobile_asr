import WebSocket from "ws";
import crypto from "crypto";

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractText(msg) {
  if (!msg || typeof msg !== "object") return { type: null, text: null };
  if (msg.type === "conversation.item.input_audio_transcription.text") {
    return { type: "asr.partial", text: msg.text || msg.stash || "" };
  }
  if (msg.type === "conversation.item.input_audio_transcription.completed") {
    return { type: "asr.final", text: msg.transcript || msg.text || "" };
  }
  if (msg.type === "session.finished") {
    return { type: "asr.final", text: msg.transcript || "" };
  }
  return { type: null, text: null };
}

function generateTaskId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now()}${Math.random().toString(16).slice(2)}`;
}

export class DashScopeASR {
  constructor({
    apiKey,
    url,
    model,
    sampleRate,
    format,
    language,
    enableServerVad,
    vadSilenceMs,
    vadThreshold,
    protocol,
    transcriptionEnabled,
    translationEnabled,
    translationTargetLanguages,
    sourceLanguage,
    sessionUpdateTemplate,
    funAsrSemanticPunctuationEnabled,
    funAsrMaxSentenceSilenceMs,
    funAsrMultiThresholdModeEnabled,
    onPartial,
    onFinal,
    onTranslationPartial,
    onTranslationFinal,
    onError,
    log
  }) {
    this.apiKey = apiKey;
    this.url = url;
    this.model = model;
    this.sampleRate = sampleRate || 16000;
    this.format = format || "pcm";
    this.language = language || "zh";
    this.sourceLanguage = sourceLanguage || null;
    this.enableServerVad = enableServerVad ?? true;
    this.vadSilenceMs = vadSilenceMs ?? 400;
    this.vadThreshold = vadThreshold ?? 0.0;
    this.protocol = protocol || null;
    this.transcriptionEnabled = transcriptionEnabled ?? true;
    this.translationEnabled = translationEnabled ?? false;
    this.translationTargetLanguages = translationTargetLanguages || [];
    this.onPartial = onPartial || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onTranslationPartial = onTranslationPartial || (() => {});
    this.onTranslationFinal = onTranslationFinal || (() => {});
    this.onError = onError || (() => {});
    this.log = log || (() => {});

    this.ws = null;
    this.ready = false;
    this.queue = [];
    this.taskId = null;
    this.sessionUpdateTemplate = sessionUpdateTemplate || null;
    this.funAsrSemanticPunctuationEnabled = funAsrSemanticPunctuationEnabled;
    this.funAsrMaxSentenceSilenceMs = funAsrMaxSentenceSilenceMs;
    this.funAsrMultiThresholdModeEnabled = funAsrMultiThresholdModeEnabled;
  }

  async connect() {
    if (!this.apiKey) throw new Error("missing DashScope api key");

    const protocol = this._getProtocol();
    this.log("connect", { protocol, model: this.model, url: this.url });
    const headers = {
      Authorization: `Bearer ${this.apiKey}`
    };

    let wsUrl = this.url;
    if (protocol === "realtime") {
      headers["OpenAI-Beta"] = "realtime=v1";
      const url = new URL(this.url);
      if (this.model) url.searchParams.set("model", this.model);
      wsUrl = url.toString();
    }

    this.ws = new WebSocket(wsUrl, { headers });

    this.ws.on("open", () => {
      if (protocol === "realtime") {
        this.ready = true;
        this._sendSessionUpdate();
        this._flush();
        return;
      }
      this._sendRunTask();
    });

    this.ws.on("message", (data) => {
      const text = data.toString("utf8");
      const msg = safeJsonParse(text);
      if (!msg) return;
      if (protocol === "realtime") {
        const { type, text: t } = extractText(msg);
        if (type === "asr.partial") this.onPartial(t);
        if (type === "asr.final") this.onFinal(t);
        return;
      }
      this._handleInferenceMessage(msg);
    });

    this.ws.on("error", (err) => {
      this.onError(err);
    });

    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  _sendSessionUpdate() {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    if (this.sessionUpdateTemplate) {
      this.ws.send(JSON.stringify(this.sessionUpdateTemplate));
      return;
    }

    const event = {
      event_id: `event_${Date.now()}`,
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: this.format,
        sample_rate: this.sampleRate,
        input_audio_transcription: {
          language: this.language
        },
        turn_detection: this.enableServerVad
          ? { type: "server_vad", threshold: this.vadThreshold, silence_duration_ms: this.vadSilenceMs }
          : null
      }
    };
    this.ws.send(JSON.stringify(event));
  }

  _getProtocol() {
    if (this.protocol) return this.protocol;
    if (this.url?.includes("/api-ws/v1/inference")) return "inference";
    if (this.model?.startsWith("fun-asr-") || this.model?.startsWith("gummy-")) return "inference";
    return "realtime";
  }

  _sendRunTask() {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    this.taskId = generateTaskId();
    const isGummy = this.model?.startsWith("gummy-");

    const parameters = {
      format: this.format,
      sample_rate: this.sampleRate
    };

    if (isGummy) {
      const targetLanguages = this.translationTargetLanguages.length
        ? this.translationTargetLanguages
        : [];
      if (this.sourceLanguage) parameters.source_language = this.sourceLanguage;
      parameters.transcription_enabled = this.transcriptionEnabled;
      parameters.translation_enabled = this.translationEnabled && targetLanguages.length > 0;
      if (targetLanguages.length > 0) parameters.translation_target_languages = targetLanguages;
      if (this.vadSilenceMs != null) parameters.max_end_silence = this.vadSilenceMs;
    } else if (this.language) {
      parameters.language_hints = [this.language];
      if (this.funAsrSemanticPunctuationEnabled != null) {
        parameters.semantic_punctuation_enabled = this.funAsrSemanticPunctuationEnabled;
      }
      if (this.funAsrMaxSentenceSilenceMs != null) {
        parameters.max_sentence_silence = this.funAsrMaxSentenceSilenceMs;
      }
      if (this.funAsrMultiThresholdModeEnabled != null) {
        parameters.multi_threshold_mode_enabled = this.funAsrMultiThresholdModeEnabled;
      }
    }

    const event = {
      header: {
        action: "run-task",
        task_id: this.taskId,
        streaming: "duplex"
      },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: this.model,
        parameters,
        input: {}
      }
    };

    this.ws.send(JSON.stringify(event));
    this.log("run-task", { taskId: this.taskId, model: this.model, isGummy });
  }

  _handleInferenceMessage(msg) {
    const event = msg?.header?.event;
    if (!event) return;

    if (event === "task-started") {
      this.log("task-started", { taskId: msg?.header?.task_id });
      this.ready = true;
      this._flush();
      return;
    }

    if (event === "result-generated") {
      this.log("result-generated");
      const output = msg?.payload?.output || {};
      const transcription = output.transcription || output.sentence;
      if (transcription?.text) {
        const isFinal = transcription.sentence_end === true;
        if (isFinal) this.onFinal(transcription.text);
        else this.onPartial(transcription.text);
      }

      const translations = Array.isArray(output.translations) ? output.translations : [];
      translations.forEach((translation) => {
        if (!translation?.text) return;
        const isFinal = translation.sentence_end === true;
        if (isFinal) this.onTranslationFinal(translation.text, translation.lang);
        else this.onTranslationPartial(translation.text, translation.lang);
      });
      return;
    }

    if (event === "task-failed") {
      const errorMessage = msg?.header?.error_message || "task failed";
      this.onError(new Error(errorMessage));
      this.log("task-failed", { errorMessage });
      return;
    }
  }

  sendAudio(pcmBuf) {
    if (!pcmBuf) return;
    if (!this.ready || !this.ws || this.ws.readyState !== this.ws.OPEN) {
      this.queue.push(pcmBuf);
      return;
    }

    if (this._getProtocol() === "inference") {
      this.ws.send(pcmBuf);
      return;
    }

    const b64 = pcmBuf.toString("base64");
    const event = {
      event_id: `event_${Date.now()}`,
      type: "input_audio_buffer.append",
      audio: b64
    };
    this.ws.send(JSON.stringify(event));
  }

  _flush() {
    if (!this.queue.length) return;
    const items = this.queue.splice(0, this.queue.length);
    items.forEach((buf) => this.sendAudio(buf));
  }

  finish() {
    if (!this.ws) return;
    if (this._getProtocol() === "inference") {
      if (!this.taskId) return;
      const event = {
        header: {
          action: "finish-task",
          task_id: this.taskId,
          streaming: "duplex"
        },
        payload: { input: {} }
      };
      this.ws.send(JSON.stringify(event));
      return;
    }

    if (!this.enableServerVad) {
      this.ws.send(JSON.stringify({ event_id: `event_${Date.now()}`, type: "input_audio_buffer.commit" }));
    }
    this.ws.send(JSON.stringify({ event_id: `event_${Date.now()}`, type: "session.finish" }));
  }

  stop() {
    if (!this.ws) return;
    this.ws.close();
    this.ws = null;
    this.ready = false;
    this.queue = [];
  }
}
