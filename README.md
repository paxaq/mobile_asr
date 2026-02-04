# Jason's ASR

Real‑time speech recognition and translation for iPhone Safari.

## Quick start

```
cd server
npm i
node src/index.js
```

Open in Safari:

```
http://<LAN-IP>:8080/
```

> iPhone requires HTTPS for microphone access.

## Local HTTPS (mkcert)

Generate certs (already created in certs/):

```
mkcert -install
mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1 ::1 <LAN-IP>
```

Run HTTPS reverse proxy:

```
node server/src/httpsProxy.js
```

Open:

```
https://<LAN-IP>:8443/
```

## Configuration

All server settings are in server/src/config.js and environment variables. You can place them in `server/.env` (dotenv is enabled).

Minimum required:

```
DASHSCOPE_API_KEY=your_api_key
```

Optional:

```
DASHSCOPE_MODEL=fun-asr-realtime
DASHSCOPE_URL_INFERENCE=wss://dashscope.aliyuncs.com/api-ws/v1/inference
DASHSCOPE_URL_REALTIME=wss://dashscope.aliyuncs.com/api-ws/v1/realtime
DASHSCOPE_LANGUAGE=en
DASHSCOPE_SOURCE_LANGUAGE=auto
DASHSCOPE_TRANSLATION_ENABLED=true
DASHSCOPE_TRANSLATION_TARGET=en
DASHSCOPE_VAD=true
DASHSCOPE_VAD_SILENCE_MS=400
DASHSCOPE_VAD_THRESHOLD=0.0
DASHSCOPE_FUN_ASR_SEMANTIC_PUNCTUATION_ENABLED=false
DASHSCOPE_FUN_ASR_MAX_SENTENCE_SILENCE_MS=600
DASHSCOPE_FUN_ASR_MULTI_THRESHOLD_MODE_ENABLED=true
```

## Supported translation targets

zh, en, ja, ko, yue, de, fr, ru, es, it, pt, id, ar, th, hi, da, ur, tr, nl, ms, vi

## Troubleshooting (iPhone mic)

1) Open via HTTPS.
2) iOS Settings → Safari → Microphone → Allow.
3) Tap Start again if the permission prompt timed out.
---
