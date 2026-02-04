class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = options?.processorOptions || {};
    this.srcRate = sampleRate;
    this.dstRate = p.dstRate || 16000;
    this.frameSamples = p.frameSamples || 320;
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

    const mono = input[0];
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
