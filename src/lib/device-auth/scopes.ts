/** Shared wire contract. No server imports: also consumed by CLI. */
const domains = {
  knowledge: ['read', 'write', 'delete'],
  projects: ['read', 'write', 'delete'],
  tasks: ['read', 'write', 'delete', 'execute'],
  objectives: ['read', 'write', 'delete', 'execute'],
  conversations: ['read', 'write', 'delete', 'execute'],
  files: ['read', 'write', 'delete'],
  memories: ['read', 'write', 'delete'],
  schedules: ['read', 'write', 'delete', 'execute'],
  datasets: ['read', 'write', 'delete', 'execute'],
  meetings: ['write', 'delete', 'execute'],
  mail: ['read', 'organize', 'send'],
  reports: ['read'],
  notifications: ['read', 'acknowledge'],
  sandboxes: ['read', 'control'],
  git: ['push'],
} as const;
export const DEVICE_SCOPES = Object.entries(domains).flatMap(
  ([domain, actions]) =>
    actions.map((action) => ({
      id: `${domain}:${action}`,
      domain,
      action,
      powerful: ['execute', 'send', 'control', 'push', 'delete'].includes(
        action,
      ),
    })),
);
export const DEVICE_SCOPE_IDS = new Set(DEVICE_SCOPES.map((s) => s.id));
export type PairingStarted = {
  id: string;
  deviceId: string;
  userCode: string;
  pollingSecret: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
};
export const GRANT_DAYS = [1, 7, 30, 90] as const;
