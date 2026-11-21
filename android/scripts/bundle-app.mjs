#!/usr/bin/env node
// App bundle 收集（design-android-mobile-app §6.2）：从仓库收集 thin-server 运行时闭包，
// 保留相对目录层级（bin/thin-server.js + lib/** + frontend/dist + package.json + node_modules），
// 使 bin/thin-server.js 的 require('../package.json') / require('../lib/*') 与硬编码的
// DIST_DIR = __dirname/../frontend/dist 全部无需修改（§3「关键决策」）。
//
// 用法：
//   node scripts/bundle-app.mjs [--repo <AgentLRay 根>] [--staging <dir>]
//       [--out <app-bundle.tgz>] [--manifest <app.manifest.json>] [--version <v>]
//
// 输出：默认 <repo>/android/build/app-bundle/staging/ 与 <repo>/android/build/app-bundle/app-bundle.tgz。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressRuntime, sha256, writeManifest } from './package-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 需要运行时闭包的最小组：薄服务（bin/thin-server.js → lib/{routes,hosts,transport,dsh,csrf,secret,config,hosts-file}）
 *  的依赖（package.json dependencies）。devDependencies（biome/typescript 等）排除。 */
const RUNTIME_DEPS = ['express', 'ws', 'zod', '@lukeburns/clatterjs'];

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

/** 拷贝目录（含子目录与符号链接）。 */
function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`源目录缺失：${srcDir}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(src), dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

/** 拷贝顶层依赖及其 npm 平铺依赖到 node_modules。 */
function copyNodeModules(repoNodeModules, destNodeModules) {
  fs.mkdirSync(destNodeModules, { recursive: true });
  const seen = new Set();
  const queue = [...RUNTIME_DEPS];
  while (queue.length) {
    const pkgName = queue.shift();
    if (seen.has(pkgName)) continue;
    seen.add(pkgName);
    const src = path.join(repoNodeModules, pkgName);
    if (!fs.existsSync(src)) throw new Error(`缺少运行时依赖（请先 npm install）：${pkgName}`);
    copyDir(src, path.join(destNodeModules, pkgName));
    // 收集该包声明的依赖（平铺在上层 node_modules；也需一起拷）。
    const pkgJson = path.join(src, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const deps = readJson(pkgJson).dependencies ?? {};
      for (const d of Object.keys(deps)) {
        if (!seen.has(d)) queue.push(d);
      }
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** 拷贝 lib/**，排除 lib/dsh/vendor/src 与 tsconfig 等非运行时文件（§6.2）。 */
function copyLib(repoLib, destLib) {
  copyDir(repoLib, destLib);
  // 排除 vendor 源码目录与构建中间件（只留 dist）。
  for (const extra of ['src', 'tsconfig.json']) {
    const p = path.join(destLib, 'dsh', 'vendor', extra);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repo ?? path.join(__dirname, '..', '..'));
  const buildDir = path.resolve(args.staging ?? path.join(repoRoot, 'android', 'build', 'app-bundle'));
  const staging = path.join(buildDir, 'staging');
  const out = path.resolve(args.out ?? path.join(buildDir, 'app-bundle.tgz'));
  const manifestFile = path.resolve(args.manifest ?? path.join(buildDir, 'app.manifest.json'));

  const repoDist = path.join(repoRoot, 'frontend', 'dist');
  const repoLib = path.join(repoRoot, 'lib');
  const repoNodeModules = path.join(repoRoot, 'node_modules');
  if (!fs.existsSync(repoDist) || !fs.existsSync(path.join(repoDist, 'index.html'))) {
    throw new Error('frontend/dist 未构建：请先在仓库根运行 `npm run build:ui`');
  }

  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  // package.json（bin/thin-server.js 需 require('../package.json')）
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(staging, 'package.json'));
  // bin/thin-server.js
  fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'bin', 'thin-server.js'), path.join(staging, 'bin', 'thin-server.js'));
  // lib/**
  copyLib(repoLib, path.join(staging, 'lib'));
  // frontend/dist/**
  copyDir(repoDist, path.join(staging, 'frontend', 'dist'));
  // node_modules 运行时闭包
  copyNodeModules(repoNodeModules, path.join(staging, 'node_modules'));

  // 压缩 + 清单
  compressRuntime(staging, out);
  const digest = await sha256(out);
  const repoVersion = readJson(path.join(repoRoot, 'package.json')).version ?? 'dev';
  const version = args.version && args.version !== 'true' ? args.version : repoVersion;
  await writeManifest(manifestFile, { version, sha256: digest, size: fs.statSync(out).size });
  console.log(`✔ app-bundle.tgz  ${digest}  ${(fs.statSync(out).size / 1e6).toFixed(1)}MB`);
  console.log(`  staging: ${staging}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
