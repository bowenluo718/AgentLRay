import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor 壳配置（design-android-mobile-app §4.6 方案 A）：
// - webDir 指向本地占位页（www/），仅用于 BridgeActivity 起 WebView；
// - 不设 server.url（避免 onCreate 立即加载未就绪的 3801 → ERR_CONNECTION_REFUSED）；
//   MainActivity 在薄服务 /api/version 就绪后主动 bridge.getWebView().loadUrl('http://127.0.0.1:3801')；
// - allowNavigation 让 WebView 内联加载本地薄服务页面（而非跳外部浏览器）。
//   **必须是裸主机名**：Capacitor 的 HostMask 按 `.` 切分、逐段比对 `Uri.getHost()`，
//   写成 `http://127.0.0.1:3801` 会被切成 ["http://127","0","0","1:3801"]，永远匹配不上
//   host `127.0.0.1` → 每次导航都被判为外部 URL 交给系统浏览器（ACTION_VIEW）。
//   端口不参与匹配（薄服务的端口由 NodeRuntimeManager 决定，见 ThinNavigation）。
// - cleartext: true 允许 WebView 导航到本地明文 HTTP 薄服务（loopback 无 TLS）。
const config: CapacitorConfig = {
  appId: 'com.agentlray.app',
  appName: 'AgentLRay',
  webDir: 'www',
  server: {
    cleartext: true,
    allowNavigation: ['127.0.0.1'],
  },
};

export default config;
