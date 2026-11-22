import { McpServerDeps } from './auth.js';
import { sendMessage } from '../modules/messaging/send-message.js';
import {
  registeredGroups,
  registerGroup,
  updateGroup,
} from '../state-manager.js';

export const sharedDeps: McpServerDeps = {
  sendMessage,
  getRegisteredGroups: () => registeredGroups,
  registerGroup,
  updateGroup,
};
