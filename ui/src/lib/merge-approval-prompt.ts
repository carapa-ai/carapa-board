import { create } from 'zustand';
import type { HeldMergeApproval } from '@/lib/api';

export interface MergeApprovalPrompt {
  projectId: string;
  items: Array<{ taskId: string; title: string; approval: HeldMergeApproval }>;
  /** Repeats the held action for the tasks whose approval was applied. */
  retry: (approvedTaskIds: string[]) => void;
}

export const usePromptStore = create<{
  prompt: MergeApprovalPrompt | null;
  set: (prompt: MergeApprovalPrompt | null) => void;
}>((set) => ({ prompt: null, set: (prompt) => set({ prompt }) }));

/** The held-merge approval a failed request carried, if any. */
export function approvalOfError(err: unknown): HeldMergeApproval | undefined {
  return err instanceof Error
    ? (err as { approval?: HeldMergeApproval }).approval
    : undefined;
}

/** Ask the user to approve the held merges; Cancel leaves the approvals pending. */
export function promptMergeApproval(prompt: MergeApprovalPrompt) {
  usePromptStore.getState().set(prompt);
}
