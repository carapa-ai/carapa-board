interface BootLockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const NEXT_BOOT_LOCK_KEY = 'native_lock_on_next_boot_v1';

function browserStorage(): BootLockStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function requestNativeBootLock(
  storage: BootLockStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(NEXT_BOOT_LOCK_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function cancelNativeBootLock(
  storage: BootLockStorage | undefined = browserStorage(),
): void {
  try {
    storage?.removeItem(NEXT_BOOT_LOCK_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Decide whether a native WebView boot must start locked. OTA activation sets
 * a one-shot override because its immediate restart otherwise looks exactly
 * like a share-intent WebView recreation inside the background grace period.
 */
export function shouldLockNativeBoot(
  hiddenWithinGrace: boolean,
  storage: BootLockStorage | undefined = browserStorage(),
): boolean {
  try {
    if (storage?.getItem(NEXT_BOOT_LOCK_KEY) === '1') {
      storage.removeItem(NEXT_BOOT_LOCK_KEY);
      return true;
    }
  } catch {
    // Fall through to the normal cold-boot decision when storage is unusable.
  }
  return !hiddenWithinGrace;
}
