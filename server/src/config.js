function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  return String(value).toLowerCase() === "true";
}

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseList(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export const config = {
  debug: {
    asr: String(process.env.DEBUG || "").toLowerCase().includes("asr")
  },
  dashscope: {
    apiKey: process.env.DASHSCOPE_API_KEY,
    defaultModel: process.env.DASHSCOPE_MODEL || "fun-asr-realtime",
    urlInference: process.env.DASHSCOPE_URL_INFERENCE || "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    urlRealtime: process.env.DASHSCOPE_URL_REALTIME || "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    language: process.env.DASHSCOPE_LANGUAGE || "en",
    sourceLanguage: process.env.DASHSCOPE_SOURCE_LANGUAGE || null,
    vad: {
      enabled: parseBool(process.env.DASHSCOPE_VAD, true),
      silenceMs: parseNumber(process.env.DASHSCOPE_VAD_SILENCE_MS, 400),
      threshold: parseNumber(process.env.DASHSCOPE_VAD_THRESHOLD, 0.0)
    },
    funAsr: {
      semanticPunctuationEnabled: parseBool(process.env.DASHSCOPE_FUN_ASR_SEMANTIC_PUNCTUATION_ENABLED, false),
      maxSentenceSilenceMs: parseNumber(process.env.DASHSCOPE_FUN_ASR_MAX_SENTENCE_SILENCE_MS, 800),
      multiThresholdModeEnabled: parseBool(process.env.DASHSCOPE_FUN_ASR_MULTI_THRESHOLD_MODE_ENABLED, true)
    },
    translation: {
      enabled: parseBool(process.env.DASHSCOPE_TRANSLATION_ENABLED, true),
      targetLanguages: parseList(process.env.DASHSCOPE_TRANSLATION_TARGET, ["en"])
    },
    allowModels: new Set([
      "fun-asr-realtime",
      "gummy-realtime-v1"
    ]),
    sessionUpdateTemplate: parseJson(process.env.DASHSCOPE_SESSION_UPDATE)
  }
};
