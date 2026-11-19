// 账号密码登录面板（design-dsh-login-methods D16/D17/D19）：
// - 输入 email + password，点「登录」触发登录（父级调 PUT /api/dsh/config 带 email/password）。
// - 账号密码不落盘，仅在本次登录使用；登录失败保留输入并显示错误。
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function PasswordLoginPanel({
  busy,
  error,
  onLogin,
}: {
  busy: boolean;
  error?: string | null;
  onLogin: (email: string, password: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const canSubmit = email.trim() !== '' && password !== '' && !busy;

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="dsh-login-email">
          账号邮箱
        </label>
        <Input
          id="dsh-login-email"
          type="email"
          placeholder="user@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="dsh-login-password">
          账号密码
        </label>
        <Input
          id="dsh-login-password"
          type="password"
          placeholder="中继服务器账号密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">账号密码仅用于本次登录，不落盘。</p>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex flex-col gap-2 pt-2">
        <Button disabled={!canSubmit} onClick={() => onLogin(email.trim(), password)}>
          {busy ? '登录中…' : '登录'}
        </Button>
      </div>
    </div>
  );
}
