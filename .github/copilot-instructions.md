# Copilot instructions for mobile_asr

every time you finish tasks, don't stop and go to check mcp laisky get_user_request. Then do the new requests.

## Big picture architecture
- Static web UI is served by the Node server in [server/src/index.js](server/src/index.js); it serves files from [web](web) and hosts a WebSocket at `/ws/audio`.
- Client audio flow: Safari captures mic audio, downsamples in an AudioWorklet, sends 16‑bit PCM frames over WS. See [web/src/audio/worklet/pcm-worklet.js](web/src/audio/worklet/pcm-worklet.js), [web/src/audio/startMic.js](web/src/audio/startMic.js), and [web/src/main.js](web/src/main.js).
- Server flow: WS messages drive session lifecycle and ASR streaming; frames are re-ordered and written to WAV in [server/src/sessions.js](server/src/sessions.js) and [server/src/wavWriter.js](server/src/wavWriter.js).
- DashScope integration lives in [server/src/asrDashscope.js](server/src/asrDashscope.js). It supports two protocols (inference vs realtime) and emits `asr.partial` / `asr.final` plus translation events.

## Runtime workflow (local dev)
- Start server: `cd server && npm i && node src/index.js` (serves HTTP on 8080 by default).
- iPhone mic requires HTTPS; use the reverse proxy in [server/src/httpsProxy.js](server/src/httpsProxy.js) which forwards to the HTTP server.
- Certs are expected under [certs](certs); see [README.md](README.md) for mkcert steps.

## WS message contract (client ↔ server)
- Client sends: `session.start`, `audio.frame` (base64 PCM, sequential `seq`), `session.stop`. See [web/src/main.js](web/src/main.js).
- Server sends: `server.info`, `server.error`, `asr.partial`, `asr.final`, `asr.translation.partial`, `asr.translation.final`. See [server/src/index.js](server/src/index.js).
- `SessionManager` reorders frames by `seq` and enforces fixed frame size; keep `frame_ms` and `sample_rate` consistent with the client worklet.

## Configuration & external dependencies
- Configuration is environment-driven via [server/src/config.js](server/src/config.js) with dotenv enabled; local overrides belong in server/.env.
- DashScope requires `DASHSCOPE_API_KEY`; model selection and translation options come from env and client `session.start` payload.
- Only models in `config.dashscope.allowModels` are accepted; unsupported models fall back to `defaultModel`.

## Project-specific conventions
- Translation is only enabled for gummy models; UI toggles translation based on model selection in [web/src/main.js](web/src/main.js).
- `WSClient` auto-reconnects with backoff; server-side auth is minimal (`verifyToken`) for demo use in [server/src/auth.js](server/src/auth.js).
- Audio is stored as WAV per session under [server/recordings](server/recordings); do not change session IDs without updating naming expectations.