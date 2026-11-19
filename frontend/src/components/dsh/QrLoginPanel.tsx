// 扫码登录面板（design-dsh-login-methods D20-D23 / D28-D29）：
// - 渲染当前 provider 的二维码 + 跳转链接（新标签打开 scanUrl 完成登录）。
// - 1.5s 轮询 pollDshQrLogin；complete → 回调 onComplete(targetServerUrl)（父级刷新配置进入登录态）；
//   expired → 显示刷新；失败 → 显示重试。
// - 目标 serverUrl 在发起时冻结（start/poll 同一地址）；切 provider/role 或卸载清理轮询与 qrId。
// - 回调/地址走 ref，避免父级重渲染（onComplete 新引用）触发会话重启。
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { pollDshQrLogin, startDshQrLogin } from '@/api/client';

type QrState = 'loading' | 'active' | 'expired' | 'failed' | 'complete';

export function QrLoginPanel({
  role,
  provider,
  serverUrl,
  onComplete,
}: {
  role: 'host' | 'client';
  provider: string;
  /** 目标中继地址（draft.serverUrl）：start 与 poll 传同一值，token 以该 baseUrl 落盘。 */
  serverUrl?: string;
  /** 扫码成功回调，回传本次使用的目标 serverUrl（供父级持久化配置）。 */
  onComplete: (targetServerUrl: string) => void;
}) {
  const [state, setState] = useState<QrState>('loading');
  const [img, setImg] = useState<string | null>(null);
  const [scanUrl, setScanUrl] = useState('');
  const [error, setError] = useState('');
  const qrIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runRef = useRef(0);
  const onCompleteRef = useRef(onComplete);
  const serverUrlRef = useRef(serverUrl);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);
  useEffect(() => {
    serverUrlRef.current = serverUrl;
  }, [serverUrl]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    const run = ++runRef.current;
    clearTimer();
    setState('loading');
    setError('');
    setImg(null);
    // 冻结本次会话的目标地址：start 与所有 poll 必须同一 serverUrl。
    const targetServerUrl = serverUrlRef.current || '';
    try {
      const session = await startDshQrLogin({ role, provider, serverUrl: targetServerUrl || undefined });
      if (run !== runRef.current) return;
      qrIdRef.current = session.qrId;
      setScanUrl(session.scanUrl);
      const dataUrl = await QRCode.toDataURL(session.scanUrl, {
        width: 184,
        margin: 1,
        errorCorrectionLevel: 'L',
      });
      if (run !== runRef.current) return;
      setImg(dataUrl);
      setState('active');

      const poll = async () => {
        if (run !== runRef.current || !qrIdRef.current) return;
        try {
          const res = await pollDshQrLogin({
            role,
            qrId: qrIdRef.current,
            serverUrl: targetServerUrl || undefined,
          });
          if (run !== runRef.current) return;
          if (res.status === 'complete') {
            clearTimer();
            setState('complete');
            onCompleteRef.current(targetServerUrl);
          } else if (res.status === 'expired') {
            clearTimer();
            setState('expired');
          }
        } catch (e) {
          if (run !== runRef.current) return;
          setError((e as Error).message);
        }
      };
      void poll();
      timerRef.current = setInterval(poll, 1500);
    } catch (e) {
      if (run !== runRef.current) return;
      setError((e as Error).message);
      setState('failed');
    }
  }, [role, provider, clearTimer]);

  useEffect(() => {
    start();
    return () => {
      runRef.current += 1;
      clearTimer();
    };
  }, [start, clearTimer]);

  // 失败/过期重试
  const retry = () => {
    setState('loading');
    void start();
  };

  if (state === 'complete') {
    return <p className="text-sm text-muted-foreground">扫码登录成功，正在保存配置…</p>;
  }

  return (
    <div className="space-y-3 flex flex-col justify-center items-center">
      {state === 'loading' && !img ? (
        <div className="flex h-[184px] w-[184px] items-center justify-center rounded border text-xs text-muted-foreground">
          正在生成二维码…
        </div>
      ) : img ? (
        <div className="space-y-1 flex flex-col justify-center items-center">
          <div className="inline-block rounded border p-2">
            <img src={img} width={184} height={184} alt={`扫码登录（${provider}）`} />
          </div>
          {scanUrl ? (
            <a
              href={scanUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline"
            >
              在新标签页打开登录 ↗
            </a>
          ) : null}
        </div>
      ) : null}

      {state === 'active' && (
        <p className="text-xs text-center text-muted-foreground ">请用手机扫码，或在新标签页完成登录（页面会自动检测）。</p>
      )}
      {state === 'expired' && (
        <div className="space-y-2">
          <p className="text-xs text-center text-destructive">二维码已过期。</p>
          <Button size="sm" variant="outline" onClick={retry}>
            刷新二维码
          </Button>
        </div>
      )}
      {state === 'failed' && (
        <div className="space-y-2">
          <p className="text-xs text-center text-destructive">扫码登录失败：{error || '未知错误'}</p>
          <Button size="sm" variant="outline" onClick={retry}>
            重试
          </Button>
        </div>
      )}
      {state === 'loading' && img && <p className="text-xs text-muted-foreground">已生成，等待扫码…</p>}
      {error && state !== 'failed' ? (
        <p className="text-xs text-center text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
