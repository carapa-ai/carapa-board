import { create } from 'zustand';
import type { MailDraft, MailMessageDetail, Project } from '@/types';

export interface MailNavigation {
  folder: string;
  page: number;
  query: string;
  search: string;
  uid: number | null;
  selected: number[];
  composing: boolean;
  draft: MailDraft | null;
  pending: boolean;
  error: string;
}
export const emptyMailNavigation: MailNavigation = {
  folder: 'INBOX',
  page: 1,
  query: '',
  search: '',
  uid: null,
  selected: [],
  composing: false,
  draft: null,
  pending: false,
  error: '',
};
export const useMailState = create<{
  accounts: Record<string, string>;
  navigation: Record<string, MailNavigation>;
  chooseAccount: (key: string, account: string) => void;
  update: (key: string, patch: Partial<MailNavigation>) => void;
}>((set) => ({
  accounts: {},
  navigation: {},
  chooseAccount: (key, account) =>
    set((s) => ({ accounts: { ...s.accounts, [key]: account } })),
  update: (key, patch) =>
    set((s) => ({
      navigation: {
        ...s.navigation,
        [key]: { ...(s.navigation[key] || emptyMailNavigation), ...patch },
      },
    })),
}));
export function canViewProjectMail(
  project: Project | undefined,
  user: { id: string; role: string } | null,
): boolean {
  return !!(
    project?.settings?.carapaMailEnabled &&
    user &&
    (!project.isMain || project.userId === user.id) &&
    (project.accessLevel || project.userId === user.id || user.role === 'admin')
  );
}
export function replyDraft(message: MailMessageDetail): MailDraft {
  const validId = (value: string) =>
    value.length <= 998 && /^<[^<>\s]+@[^<>\s]+>$/.test(value);
  const inReplyTo = validId(message.messageId) ? message.messageId : undefined;
  const references = [
    ...message.references.filter(validId),
    ...(inReplyTo ? [inReplyTo] : []),
  ];
  return {
    to:
      message.replyTo || message.from.match(/<([^<>]+)>/)?.[1] || message.from,
    subject: /^re:/i.test(message.subject)
      ? message.subject
      : `Re: ${message.subject}`,
    body: `\n\nOn ${message.date}, ${message.from} wrote:\n${message.bodyText
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n')}`,
    inReplyTo,
    references: [...new Set(references)].slice(-100),
  };
}
