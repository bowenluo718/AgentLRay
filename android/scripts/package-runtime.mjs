#!/usr/bin/env node
// 运行时层打包（design-android-mobile-app §6.1/§6.2）：把 staging 目录压成 .tgz 并生成
// SHA-256 清单（RootfsInstaller 启动前校验，防解压损坏/篡改）。
//
// 用法：
//   node scripts/package-runtime.mjs --src <dir> --out <file.tgz> --manifest <file.json> [--version <v>]
//
// 依赖系统 `tar`（GNU tar 支持 --gzip，或回退 `tar | gzip` 管道）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 压缩目录为 .tgz（先 tar 后 gzip；Android 内置 GZIPInputStream，零原生依赖）。
 *  说明：原设计用 .tgz + zstd-jni，但 zstd-jni 无 Android ABI 分类器（linux_aarch64 为
 *  glibc，bionic 无法加载），故按 design「解压兼容性兜底」改用 gzip。 */
export function compressRuntime(srcDir, outFile) {
  if (!fs.existsSync(path.join(srcDir))) {
    throw new Error(`源目录不存在：${srcDir}`);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmpTar = `${outFile}.tmp.tar`;
  // 1) tar（不依赖 GNU tar 扩展，兼容 busybox/toybox tar）
  const tarRes = spawnSync('tar', ['-cf', tmpTar, '-C', srcDir, '.'], { stdio: 'inherit' });
  if (tarRes.status !== 0) {
    throw new Error(`tar 打包失败（status=${tarRes.status}）`);
  }
  try {
    if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });
    // 2) gzip 压缩（-9 最高压缩；-f 覆盖；生成 <tmpTar>.gz 后改名为目标）
    const gzRes = spawnSync('gzip', ['-9', '-f', tmpTar], { stdio: 'inherit' });
    if (gzRes.status !== 0) {
      throw new Error(`gzip 压缩失败（status=${gzRes.status}）`);
    }
    fs.renameSync(`${tmpTar}.gz`, outFile);
  } finally {
    if (fs.existsSync(tmpTar)) fs.rmSync(tmpTar, { force: true });
    if (fs.existsSync(`${tmpTar}.gz`)) fs.rmSync(`${tmpTar}.gz`, { force: true });
  }
  return outFile;
}

/** 流式计算文件 SHA-256（hex）。 */
export function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** 写清单 JSON。 */
export async function writeManifest(manifestFile, { version, ...rest }) {
  const payload = { version, ...rest };
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = args.src;
  const out = args.out;
  const manifest = args.manifest;
  if (!src || !out || !manifest) {
    console.error('用法：package-runtime.mjs --src <dir> --out <file.tgz> --manifest <file.json> [--version <v>]');
    process.exit(2);
  }
  compressRuntime(src, out);
  const digest = await sha256(out);
  const version = args.version && args.version !== 'true' ? args.version : 'dev';
  await writeManifest(manifest, { version, sha256: digest, size: fs.statSync(out).size });
  console.log(`✔ ${path.basename(out)}  sha256=${digest}  size=${(fs.statSync(out).size / 1e6).toFixed(1)}MB`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
