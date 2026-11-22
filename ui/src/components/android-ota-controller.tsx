import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ANDROID_OTA_AVAILABLE_EVENT,
  ANDROID_OTA_PROMPT_EVENT,
  androidOtaFirstLoadRequired,
  applyAndroidOta,
  checkAndDownloadAndroidOta,
  clearAndroidOtaAutoApply,
  isAndroidNative,
  isAndroidOtaAutoApplyArmed,
  notifyAndroidOtaReady,
  publishAndroidOtaStatus,
  type AndroidOtaReady,
} from '@/lib/android-ota';
import { getServerConfigEpoch, subscribeServerConfig } from '@/lib/api-config';
import { completeServerChange } from '@/lib/server-config';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyErrorMessage(error: unknown): string {
  return `Could not apply Android update: ${errorText(error)}`;
}

export function AndroidOtaController() {
  const checking = useRef(false);
  const recheck = useRef(false);
  const deferredForSession = useRef(false);
  const downloadedUpdate = useRef<AndroidOtaReady | null>(null);
  const [ready, setReady] = useState<AndroidOtaReady | null>(null);
  const [incompatible, setIncompatible] = useState<{
    required: number;
    installed: number;
  } | null>(null);
  const [applying, setApplying] = useState(false);

  // Resolves true when the server changed during the check: nothing of its
  // outcome was published, so a stale result cannot pass the first-load gate.
  const runCheck = useCallback(async (): Promise<boolean> => {
    publishAndroidOtaStatus({ kind: 'checking' });
    const epoch = getServerConfigEpoch();
    const superseded = () => getServerConfigEpoch() !== epoch;
    // The first load of a paired server runs unattended: the login waits for it.
    const firstLoad = androidOtaFirstLoadRequired();
    try {
      const result = await checkAndDownloadAndroidOta();
      if (superseded()) return true;
      if (result.kind === 'unavailable') {
        downloadedUpdate.current = null;
        publishAndroidOtaStatus({
          kind: 'unavailable',
          reason: result.reason,
        });
      }
      if (result.kind === 'current') {
        downloadedUpdate.current = null;
        publishAndroidOtaStatus({ kind: 'current', version: result.version });
      }
      if (result.kind === 'ready') {
        downloadedUpdate.current = result.update;
        publishAndroidOtaStatus({
          kind: 'ready',
          version: result.update.manifest.version,
        });
        if (firstLoad || isAndroidOtaAutoApplyArmed()) {
          // First load of a paired server, or Restart was pressed on this
          // device: skip the prompt.
          clearAndroidOtaAutoApply();
          try {
            await applyAndroidOta(result.update);
          } catch (error) {
            if (superseded()) return true;
            if (firstLoad) {
              publishAndroidOtaStatus({
                kind: 'error',
                message: errorText(error),
              });
            } else {
              toast.error(applyErrorMessage(error));
            }
          }
        } else {
          setReady(result.update);
        }
      }
      if (result.kind === 'incompatible') {
        clearAndroidOtaAutoApply();
        publishAndroidOtaStatus({
          kind: 'incompatible',
          required: result.requiredNativeVersionCode,
          installed: result.nativeVersionCode,
        });
        if (!firstLoad) {
          setIncompatible({
            required: result.requiredNativeVersionCode,
            installed: result.nativeVersionCode,
          });
        }
      }
    } catch (error) {
      if (superseded()) return true;
      publishAndroidOtaStatus({ kind: 'error', message: errorText(error) });
      console.warn('[android-ota] update check failed', error);
    }
    return false;
  }, []);

  const check = useCallback(async () => {
    // The first-load gate has no prompt, so Later and a pending prompt never hold it back.
    if (
      !isAndroidNative() ||
      (!androidOtaFirstLoadRequired() &&
        ((deferredForSession.current && !isAndroidOtaAutoApplyArmed()) ||
          ready))
    )
      return;
    if (checking.current) {
      // The running check may predate the boot-time publish that follows a
      // device-requested Restart; rerun once it finishes.
      if (isAndroidOtaAutoApplyArmed()) recheck.current = true;
      return;
    }
    checking.current = true;
    try {
      let superseded = false;
      do {
        recheck.current = false;
        superseded = await runCheck();
      } while (superseded || (recheck.current && isAndroidOtaAutoApplyArmed()));
    } finally {
      checking.current = false;
    }
  }, [ready, runCheck]);

  useEffect(() => {
    if (!isAndroidNative()) return;
    void notifyAndroidOtaReady()
      .then(() =>
        completeServerChange().catch((error) =>
          console.warn('[android-ota] server change not completed', error),
        ),
      )
      .then(() => check())
      .catch((error) => {
        console.error('[android-ota] failed to mark bundle ready', error);
        if (androidOtaFirstLoadRequired()) {
          publishAndroidOtaStatus({ kind: 'error', message: errorText(error) });
        }
      });

    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const onServerRestarted = () => void check();
    const onAndroidUpdateReady = () => void check();
    const onPromptRequested = () => {
      deferredForSession.current = false;
      if (downloadedUpdate.current) {
        setReady(downloadedUpdate.current);
        return;
      }
      void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('carapa:server-restarted', onServerRestarted);
    window.addEventListener(ANDROID_OTA_AVAILABLE_EVENT, onAndroidUpdateReady);
    window.addEventListener(ANDROID_OTA_PROMPT_EVENT, onPromptRequested);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('carapa:server-restarted', onServerRestarted);
      window.removeEventListener(
        ANDROID_OTA_AVAILABLE_EVENT,
        onAndroidUpdateReady,
      );
      window.removeEventListener(ANDROID_OTA_PROMPT_EVENT, onPromptRequested);
    };
  }, [check]);

  // A pending update was verified for the previous server config.
  useEffect(
    () =>
      subscribeServerConfig(() => {
        downloadedUpdate.current = null;
        setReady(null);
        setIncompatible(null);
        // A first load under the new server must not inherit the old result.
        if (androidOtaFirstLoadRequired()) {
          publishAndroidOtaStatus({ kind: 'checking' });
          window.dispatchEvent(new Event(ANDROID_OTA_AVAILABLE_EVENT));
        }
      }),
    [],
  );

  const later = () => {
    deferredForSession.current = true;
    setReady(null);
    setIncompatible(null);
  };

  const apply = async () => {
    if (!ready || applying) return;
    setApplying(true);
    try {
      await applyAndroidOta(ready);
    } catch (error) {
      setApplying(false);
      toast.error(applyErrorMessage(error));
    }
  };

  const open = Boolean(ready || incompatible);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) later();
      }}
    >
      <DialogContent
        data-ui="android-ota-update-prompt"
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>
            {incompatible
              ? 'Android app update required'
              : 'CarapaBoard update ready'}
          </DialogTitle>
          <DialogDescription>
            {incompatible
              ? `This update needs a newer version of the Android app (native shell ${incompatible.required}; this device has ${incompatible.installed}). Update the app, then apply web updates.`
              : 'The signed update has been downloaded and verified. Restart CarapaBoard to use it.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={later}>
            Later
          </Button>
          {!incompatible && (
            <Button
              type="button"
              onClick={() => void apply()}
              disabled={applying}
            >
              {applying ? 'Restarting…' : 'Restart now'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
