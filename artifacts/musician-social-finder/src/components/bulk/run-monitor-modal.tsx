import type { RefObject } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { RunDetail } from './run-detail';

export function RunMonitorModal({ runId, open, onOpenChange, onOpenRun, triggerRef }: {
  runId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenRun: (id: string) => void;
  triggerRef: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open={open && !!runId} onOpenChange={onOpenChange}>
      <DialogContent className="investigation blk-run-modal" data-testid="dialog-run-monitor"
        onCloseAutoFocus={event => {
          if (triggerRef.current?.isConnected) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}>
        <DialogTitle className="sr-only">Run monitor</DialogTitle>
        <DialogDescription className="sr-only">Live run progress, saved results, and stop or resume controls. Closing this monitor does not stop the run.</DialogDescription>
        {runId && <RunDetail key={runId} runId={runId} onClose={() => onOpenChange(false)} onOpenRun={onOpenRun} modal />}
      </DialogContent>
    </Dialog>
  );
}
