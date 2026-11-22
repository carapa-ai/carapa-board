import { useQueryClient } from '@tanstack/react-query';
import { invalidateUnreadNotifications } from '@/hooks/use-unread-notifications';
import {
  closeNotification,
  useOpenNotification,
} from '@/lib/notification-overlay';
import { NotifDialog } from './NotifDialog';

export function NotificationOverlayHost() {
  const payloadId = useOpenNotification();
  const qc = useQueryClient();
  return (
    <NotifDialog
      key={payloadId ?? 'closed'}
      payloadId={payloadId}
      onClose={() => {
        closeNotification(payloadId ?? undefined);
        invalidateUnreadNotifications(qc);
      }}
    />
  );
}
