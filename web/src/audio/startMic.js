export async function startMic({ onFrame, dstRate = 16000, frameMs = 20, log }) {
  log ||= (() => {});
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.audioWorklet.addModule("/src/audio/worklet/pcm-worklet.js");

  const source = audioCtx.createMediaStreamSource(stream);

  const frameSamples = Math.round((dstRate * frameMs) / 1000);

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
      stream.getTracks().forEach((t) => t.stop());
      await audioCtx.close();
    }
  };
}
