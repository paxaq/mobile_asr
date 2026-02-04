import { createWavWriter } from "./wavWriter.js";

export class SessionManager {
  constructor({ recordingsDir = "./recordings" } = {}) {
    this.sessions = new Map();
    this.recordingsDir = recordingsDir;
  }

  start(sessionId, { sampleRate = 16000, frameMs = 20 } = {}) {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }
    const wav = createWavWriter(`${this.recordingsDir}/${sessionId}.wav`, sampleRate, 1);
    const frameSamples = Math.round((sampleRate * frameMs) / 1000);
    const st = {
      expectedSeq: 0,
      buffer: new Map(),
      maxReorder: 50,
      wav,
      sampleRate,
      frameMs,
      frameSamples,
      frameBytes: frameSamples * 2,
      frameCount: 0
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

    if (st.frameBytes && pcmBuf.length !== st.frameBytes) {
      return { ok: false, reason: "bad frame size", expected: st.frameBytes, got: pcmBuf.length };
    }

    if (seq < st.expectedSeq) {
      return { ok: true, dropped: true };
    }

    st.buffer.set(seq, pcmBuf);

    if (st.buffer.size > st.maxReorder) {
      const minSeq = Math.min(...st.buffer.keys());
      if (minSeq > st.expectedSeq) {
        st.expectedSeq = minSeq;
      } else {
        st.buffer.delete(minSeq);
      }
    }

    while (st.buffer.has(st.expectedSeq)) {
      const b = st.buffer.get(st.expectedSeq);
      st.buffer.delete(st.expectedSeq);
      st.wav.writePcm(b);
      st.expectedSeq++;
      st.frameCount++;
    }

    return { ok: true, frameCount: st.frameCount };
  }
}
