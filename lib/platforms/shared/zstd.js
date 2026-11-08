'use strict';
// 通用 zstd 会话日志工具（Q25/Q26=A 下沉自 dsh.js）。
//  - scanZstdFrames / decompressDshLog —— 多帧 zstd 扫描与解压（RFC 8878 边界扫描）
//  - readDshSessionLines —— 读 dsh 会话日志（压缩或明文）为行数组
// dsh 平台专属的其余逻辑仍在 platforms/dsh/parse.js；此处为共享通用扫描器
// （shared/insights、shared/watch）与 dsh 解析共同依赖的格式工具。
const fsp = require('fs/promises');
const zlib = require('node:zlib');

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

const HAS_NODE_ZSTD = typeof zlib.zstdDecompressSync === 'function';

// Scan frame boundaries of a concatenated-zstd buffer without decompressing
// block contents. Returns { frames: [{start, end}], tornStart } where
// tornStart marks the offset of a trailing incomplete/corrupt frame (null if
// the buffer ends exactly on a frame boundary).
function scanZstdFrames(buf) {
  const frames = [];
  const len = buf.length;
  let off = 0;
  while (off < len) {
    const start = off;
    if (len - off < 4) return { frames, tornStart: start };
    const magic = buf.readUInt32LE(off);
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
      if (len - off < 8) return { frames, tornStart: start };
      const size = buf.readUInt32LE(off + 4);
      if (off + 8 + size > len) return { frames, tornStart: start };
      off += 8 + size; // skippable frames carry no session data
      continue;
    }
    if (magic !== ZSTD_MAGIC) return { frames, tornStart: start };
    off += 4;
    if (off >= len) return { frames, tornStart: start };
    const descriptor = buf[off++];
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const checksumFlag = (descriptor >> 2) & 1;
    const didFlag = descriptor & 3;
    if (!singleSegment) off += 1; // Window_Descriptor
    off += [0, 1, 2, 4][didFlag]; // Dictionary_ID
    off += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]; // Frame_Content_Size
    if (off > len) return { frames, tornStart: start };
    for (;;) {
      if (off + 3 > len) return { frames, tornStart: start };
      const header = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
      off += 3;
      const lastBlock = header & 1;
      const blockType = (header >> 1) & 3;
      const blockSize = header >> 3;
      if (blockType === 3) return { frames, tornStart: start }; // reserved: corrupt
      off += blockType === 1 ? 1 : blockSize; // RLE blocks store 1 byte
      if (off > len) return { frames, tornStart: start };
      if (lastBlock) break;
    }
    if (checksumFlag) {
      off += 4;
      if (off > len) return { frames, tornStart: start };
    }
    frames.push({ start, end: off });
  }
  return { frames, tornStart: null };
}

// Multi-frame decompression: every complete frame decoded independently, then
// concatenated. A torn trailing frame is dropped.
function decompressDshLog(buffer) {
  if (!HAS_NODE_ZSTD) {
    throw new Error(
      'This dsh session log is zstd-compressed, but this Node.js build has no zstd support. ' +
        'Upgrade to Node.js >= 22.15 (node:zlib zstdDecompressSync) to view compressed dsh sessions.'
    );
  }
  const { frames } = scanZstdFrames(buffer);
  const parts = frames.map((f) => zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)));
  return Buffer.concat(parts).toString('utf8');
}

// Read a dsh session log (compressed or plain) as an array of non-empty lines.
async function readDshSessionLines(filePath) {
  if (filePath.endsWith('.zstd')) {
    const buffer = await fsp.readFile(filePath);
    return decompressDshLog(buffer)
      .split('\n')
      .filter((l) => l.trim());
  }
  const text = await fsp.readFile(filePath, 'utf8');
  return text.split('\n').filter((l) => l.trim());
}

module.exports = {
  scanZstdFrames,
  decompressDshLog,
  readDshSessionLines,
};
