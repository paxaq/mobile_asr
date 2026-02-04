import fs from "fs";

export function createWavWriter(path, sampleRate = 16000, channels = 1) {
  const fd = fs.openSync(path, "w");
  let dataBytes = 0;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(0, 40);

  fs.writeSync(fd, header);

  function writePcm(pcmBuf) {
    fs.writeSync(fd, pcmBuf);
    dataBytes += pcmBuf.length;
  }

  function close() {
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
