import { useEffect } from 'react';
import {
  CapacitorShareTarget,
  type ShareReceivedEvent,
} from '@capgo/capacitor-share-target';
import { useStore } from '@/store';

export function ShareIntentHandler() {
  useEffect(() => {
    const handleShare = (data: ShareReceivedEvent) => {
      if (!data) return;
      console.log('Share intent received:', data);

      const sharedText = data.texts?.[0] || '';
      const sharedTitle = data.title || '';

      if (!sharedText && !sharedTitle) return;

      // Ignore duplicate delivery of a share that is still pending in the store
      const state = useStore.getState();
      const current = state.sharedContent;
      if (
        current &&
        (current.title || '') === sharedTitle &&
        (current.text || '') === sharedText
      )
        return;

      state.setSharedContent({
        text: sharedText,
        title: sharedTitle,
      });
    };

    // Setup listener. Capacitor plugins often fire this immediately on registration
    // if the app was launched via the intent.
    const setupListener = async () => {
      const listener = await CapacitorShareTarget.addListener(
        'shareReceived',
        handleShare,
      );
      return listener;
    };

    const listenerPromise = setupListener();

    return () => {
      listenerPromise.then((l) => l.remove());
    };
  }, []);

  return null;
}
