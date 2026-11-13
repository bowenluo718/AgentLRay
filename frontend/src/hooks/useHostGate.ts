// 主机就绪门控：数据面是否可发（local 恒 true；远端=隧道连接+探测成功）。
// 首帧「先连后加载」：记忆远端时占位期 hostReady=false，各常驻数据面查询据此
// 在 enabled 上追加守卫，避免连接完成前以本机数据渲染/发请求。
import { useAppStore } from '@/store';

/** 当前主机数据面是否就绪。 */
export function useHostGate(): boolean {
  return useAppStore((s) => s.hostReady);
}
