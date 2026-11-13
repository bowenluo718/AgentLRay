import { useEffect } from 'react';
import { getInbound } from '@/api/client';
import { useAppStore } from '@/store';

// Inbound peers 轮询：本机被哪些其他主机连接。被连接方本地资源（getInbound 强制
// local），与当前查看的远端无关。对齐 useVersionPoller 的 setInterval + focus 刷新模式。
const POLL_MS = 10_000;

export function useInboundPoller() {
  useEffect(() => {
    let disposed = false;
    const setInbound = useAppStore.getState().setInbound;
    const poll = async () => {
      try {
        const data = await getInbound();
        if (!disposed) setInbound(data);
      } catch {
        // 服务短暂不可用：保持上次值，下次轮询重试。
      }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    window.addEventListener('focus', poll);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', poll);
    };
  }, []);
}
