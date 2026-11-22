const privacyErasureEpochs = new Map<string, number>();

export function getPrivacyErasureEpoch(group_folder: string): number {
  return privacyErasureEpochs.get(group_folder) ?? 0;
}

export function markPrivacyErasureStarted(group_folder: string): void {
  privacyErasureEpochs.set(
    group_folder,
    getPrivacyErasureEpoch(group_folder) + 1,
  );
}

/** Synchronous gate used immediately before every content-bearing write. */
export function assertPrivacyWriteEpoch(
  group_folder: string,
  expectedEpoch: number,
): void {
  if (getPrivacyErasureEpoch(group_folder) !== expectedEpoch) {
    throw new Error('Memory write discarded because privacy erasure advanced');
  }
}
