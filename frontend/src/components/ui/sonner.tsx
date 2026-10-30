import { Toaster as Sonner } from 'sonner';
import { useAppStore } from '@/store';

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Toast 主题跟随界面主题（亮/暗）。
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useAppStore((s) => s.theme);
  return (
    <Sonner
      theme={theme === 'dark' ? 'dark' : 'light'}
      className="toaster group"
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
