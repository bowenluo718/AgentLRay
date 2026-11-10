'use strict';
// 分析表面共享的会话遍历原语（C4）。
//
// search / insights / prompts / tool-audit 四处此前各重写相同骨架：collectFiles
// 收集、逐文件扫描、逐文件容错（单个坏文件不拖垮整批）、限额预算提前终止。此处把
// 「收集 + 逐文件迭代 + 容错 + 预算」这一深度 seam 折叠归一，各表面只提供：
//   - collectFiles(dir, opts)：平台文件收集（collectFiles 缺失/异常 → []）
//   - iterateFiles(files, scan, onResult)：顺序逐文件扫描 + 容错 + 预算
//   - mapFiles(files, scan)：并行逐文件扫描 + 容错（prompts 的 Promise.all 并发）
//
// 单个坏文件失败不拖垮整批：scan 抛错/拒绝 → 结果置 null，交由 onResult 跳过。
// 预算：onResult 返回 false 立即终止（search 的 remaining()）。

// 安全收集平台会话文件：collectFiles 缺失或异常 → []。
async function collectFiles(p, dir, opts) {
  if (typeof p.collectFiles !== 'function') return [];
  try {
    return (await p.collectFiles(dir, opts || {})) || [];
  } catch {
    return [];
  }
}

// 顺序逐文件扫描。scan 可为同步或 async；结果经容错（异常 → null）后交给
// onResult(f, result) 累加；onResult 返回 false 提前终止（限额预算）。
async function iterateFiles(files, scan, onResult) {
  for (const f of files) {
    let result = null;
    try {
      result = (await scan(f)) ?? null;
    } catch {
      result = null;
    }
    if (onResult) {
      const cont = await onResult(f, result);
      if (cont === false) break;
    }
  }
}

// 并行逐文件扫描（prompts 的 Promise.all 并发语义）。每文件结果容错为 null，
// 返回与 files 一一对应的结果数组；单个失败不拖垮整批。
async function mapFiles(files, scan) {
  return Promise.all(
    files.map((f) =>
      Promise.resolve(scan(f)).then(
        (r) => r,
        () => null
      )
    )
  );
}

module.exports = { collectFiles, iterateFiles, mapFiles };
