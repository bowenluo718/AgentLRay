import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor 壳配置（design-android-mobile-app §4.6 方案 A）：
// - webDir 指向本地占位页（www/），仅用于 BridgeActivity 起 WebView；
// - 不设 server.url（避免 onCreate 立即加载未就绪的 3801 → ERR_CONNECTION_REFUSED）；
//   MainActivity 在薄服务 /api/version 就绪后主动 bridge.getWebView().loadUrl('http://127.0.0.1:3801')；
// - allowNavigation 放行 127.0.0.1，让 WebView 内联加载本地薄服务页面（而非跳外部浏览器）；
// - cleartext: true 允许 WebView 导航到本地明文 HTTP 薄服务（loopback 无 TLS）。
const config: CapacitorConfig = {
  appId: 'com.agentlray.app',
  appName: 'AgentLRay',
  webDir: 'www',
  server: {
    cleartext: true,
    allowNavigation: ['http://127.0.0.1:3801', 'http://localhost:3801'],
  },
};

export default config;
