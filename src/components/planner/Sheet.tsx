import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialogFocus } from '../../lib/useDialogFocus';

export default function Sheet({ title, children, actions, onClose }: {
  title: string; children: ReactNode; actions?: ReactNode; onClose: () => void;
}) {
  const ref = useDialogFocus(true, onClose);
  return <div className="pd-sheet-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={ref} className="pd-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header className="pd-sheet-head"><h2>{title}</h2><button className="pd-icon" aria-label="关闭" onClick={onClose}><X size={17}/></button></header>
      <div className="pd-sheet-body">{children}</div>
      {actions && <footer className="pd-sheet-actions">{actions}</footer>}
    </section>
  </div>;
}
