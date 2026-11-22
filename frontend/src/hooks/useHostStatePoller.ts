import { useEffect } from 'react';
import { getHosts } from '@/api/client';
import { useAppStore } from '@/store';

// 主机链路状态轮询（A-1/A-3）：服务端在后台按指数退避自动重连，前端需感知
// reconnecting → connected 的迁移才能把连接占位页/弹框状态收敛到「已连接」。
// 仅在「当前查看的远端尚未就绪」时启用（占位页可见期间）；连接成功后由调用方关闭，
// 常驻实例不再额外轮询（用户打开主机弹框时 HostsDialog 自带 refetch）。
const POLL_MS = 2_000;

export function useHostStatePoller(enabled: boolean) {
  useEffect(() => {
    if (enabled === false) return;
    let disposed = false;
    const poll = async () => {
      try {
        const res = await getHosts();
        if (!disposed) useAppStore.getState().setHosts(res.hosts);
      } catch {
        // 服务端短暂不可用：保持上次状态，下个周期重试。
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [enabled]);
}
