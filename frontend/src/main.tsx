import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import App from './App';
import { getMode } from '@/api/client';
import { adoptTokenFromLocation } from '@/api/ui-token';
import { installBackNavigation } from '@/lib/backNavigation';
import { useAppStore } from '@/store';
import { DEMO } from '@/demo/flag';
import './index.css';

// 鉴权失败（C-1 本机令牌缺失/失效，HTTP 401）不重试：重试只会放大 401 日志，且不会自愈。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        (error as { httpStatus?: number } | null)?.httpStatus !== 401 && failureCount < 1,
      refetchOnWindowFocus: false,
    },
  },
});

// 模式门控（design-thin-service Q22）：boot 先 GET /api/mode 写入 store，薄服务据此
// 裁剪系统配置入口。解析完成前 App 渲染轻量占位，不发数据面请求。失败（后端不可达）
// 回退 full，保证完整实例在端点抖动下仍可进。
async function bootMode() {
  if (DEMO) {
    useAppStore.getState().setMode('full');
    return;
  }
  try {
    const m = await getMode();
    const thin = m.mode === 'thin';
    useAppStore.getState().setMode(thin ? 'thin' : 'full', m.capabilities ?? null);
    // 薄服务：在采用已连好的主机前保持数据面不可发（避免以 local 头抢先拉远端数据）。
    if (thin) useAppStore.getState().setHostConnecting();
  } catch {
    useAppStore.getState().setMode('full');
  }
}

async function render() {
  // 本机令牌（C-1）：启动 URL 里带令牌时写入长效缓存并抹掉地址栏（必须在任何 API 请求前）。
  await adoptTokenFromLocation();
  await bootMode();
  // 系统返回键 → 页面内后退（design-android-system-back）。只装一次：StrictMode 会重复
  // 执行 effect，而 history 改写不能重复；浏览器（完整实例）没有原生桥，上报自动空转。
  installBackNavigation();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster position="top-center" />
      </QueryClientProvider>
    </React.StrictMode>
  );
}

void render();
