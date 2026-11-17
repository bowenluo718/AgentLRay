import { Toaster as Sonner } from 'sonner';
import { useAppStore } from '@/store';

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Toast 主题跟随界面主题（亮/暗）。
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useAppStore((s) => s.theme);
  return (
    <Sonner
      theme={theme === 'dark' ? 'dark' : 'light'}
      // pointer-events-auto：toaster 挂载在 #root（body 后代）内，而 pointer-events 是
      // 继承属性。当 Radix Dialog/Popover（react-remove-scroll）在 body 上短暂设置
      // pointer-events:none 时，toast 整条链会继承 none，导致 action 按钮点击无效、
      // 文本无法选中（JS 直调 location.reload() 仍有效）。在容器上强制恢复 auto 即可
      // 命中此"点透/层级"根因；隐藏 toast 的 [data-visible=false]{pointer-events:none}
      // 直接作用于 toast 元素自身，仍优先，动画不受影响。
      className="toaster group pointer-events-auto"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
