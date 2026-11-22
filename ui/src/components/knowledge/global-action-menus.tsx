import { useStore } from '@/store';
import { SaveToKBDialog } from './save-to-kb-dialog';
import { MessageActionsOverlay } from './message-actions-overlay';

export function GlobalActionMenus() {
  const kbSaveDialogInfo = useStore((s) => s.kbSaveDialogInfo);
  const setKbSaveDialogInfo = useStore((s) => s.setKbSaveDialogInfo);
  const messageActionsInfo = useStore((s) => s.messageActionsInfo);
  const setMessageActionsInfo = useStore((s) => s.setMessageActionsInfo);

  return (
    <>
      {kbSaveDialogInfo && (
        <SaveToKBDialog
          open={!!kbSaveDialogInfo}
          onOpenChange={(open) => !open && setKbSaveDialogInfo(null)}
          content={kbSaveDialogInfo.content}
          project_id={kbSaveDialogInfo.project_id}
        />
      )}
      {messageActionsInfo && !kbSaveDialogInfo && (
        <MessageActionsOverlay
          id={messageActionsInfo.id}
          content={messageActionsInfo.content}
          project_id={messageActionsInfo.project_id}
          anchorY={messageActionsInfo.anchorY}
          hasFork={messageActionsInfo.hasFork}
          onClose={() => setMessageActionsInfo(null)}
        />
      )}
    </>
  );
}
