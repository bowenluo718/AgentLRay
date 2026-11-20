// 统一文件保存入口（design-android-mobile-app §7.6）：
// Android WebView 不支持 blob 下载（URL.createObjectURL + a.download）。当 Capacitor 注入
// 原生 SaveFile 插件（android/ 工程自定义插件）且薄服务下发 capabilities.nativeSave=true 时，
// 改走原生保存/分享；否则退回浏览器 blob 下载（桌面/常规浏览器不变）。
//
// 能力位来源：store.modeCapabilities.nativeSave（thin 由 /api/mode 下发）。插件探测兜底：
// 全局 window.Capacitor.Plugins.SaveFile 存在即认为原生桥可用（Capacitor 注入，无需前端依赖
// @capacitor/core，避免把原生耦合进纯 web 构建）。
import { useAppStore } from '@/store';

interface SaveFilePlugin {
  saveFile(opts: { base64: string; fileName: string; mimeType: string }): Promise<{ uri?: string }>;
}

function getNativePlugin(): SaveFilePlugin | null {
  // Capacitor 在 WebView 注入全局 window.Capacitor（本仓库不与 @capacitor/core 构建耦合）。
  // 运行时收窄：只认对象且 Plugins.SaveFile.saveFile 为函数，避免对未知全局盲目断言。
  const cap: unknown = (globalThis as { Capacitor?: unknown }).Capacitor;
  if (!cap || typeof cap !== 'object' || !('Plugins' in cap)) return null;
  const plugins = cap.Plugins;
  if (!plugins || typeof plugins !== 'object' || !('SaveFile' in plugins)) return null;
  const saveFile = plugins.SaveFile;
  if (!saveFile || typeof saveFile !== 'object' || !('saveFile' in saveFile)) return null;
  const fn = saveFile.saveFile;
  if (typeof fn !== 'function') return null;
  return saveFile as SaveFilePlugin;
}

/** 是否启用原生保存：能力位开启且插件存在。 */
export function nativeSaveEnabled(): boolean {
  return useAppStore.getState().modeCapabilities?.nativeSave === true && getNativePlugin() !== null;
}

/** UTF-8 安全 base64（btoa 仅接受 Latin-1，中文/emoji 需先编码为字节）。 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    // 分块避免 String.fromCharCode 参数过多导致栈溢出（大导出文件）。
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** 浏览器 blob 下载（桌面/常规浏览器）。 */
function blobDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 保存文本文件（同步入口，调用方无需 await）。
 * - 启用原生保存：调 SaveFile 插件写盘/分享（异步，失败回退 blob 并在控制台记录）；
 * - 否则：blob 下载。
 * 返回值：'native' | 'blob'（便于测试/调用方分支，可选）。
 */
export function saveTextFile(content: string, filename: string, mimeType: string): 'native' | 'blob' {
  const plugin = nativeSaveEnabled() ? getNativePlugin() : null;
  if (plugin) {
    plugin
      .saveFile({ base64: toBase64(content), fileName: filename, mimeType })
      .catch((error: unknown) => {
        // 原生保存失败（用户取消/权限）→ 回退浏览器下载，不阻塞导出。
        console.warn('原生保存失败，回退浏览器下载：', error);
        blobDownload(content, filename, mimeType);
      });
    return 'native';
  }
  blobDownload(content, filename, mimeType);
  return 'blob';
}
