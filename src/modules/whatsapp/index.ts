/**
 * WhatsApp messaging module — optional WhatsApp integration via carapa-wa-link.
 *
 * When enabled, registers a MessagingProvider that routes outbound messages
 * through carapa-wa-link, and starts the inbound message polling loop.
 *
 * The board loads this entrypoint only when WhatsApp is enabled.
 */

import type { CarapaModule } from '../types.js';
import { ENABLE_WHATSAPP } from './config.js';
import { setMessagingProvider } from '../messaging/registry.js';
import { getMessagingClient } from './messaging-client.js';
import { startMessageLoop, stopMessageLoop } from './whatsapp-router.js';
import { ensureWaLinkStack } from './stack.js';
import whatsappRoutes from './whatsapp-routes.js';

import { logger } from '../../logger.js';
import type { MessagingProvider } from '../messaging/types.js';
import { TOOLSET_MODULES } from '../tools/registry.js';
import { registerGroupTool } from './tools.js';

/** Wrap the existing MessagingClient as a MessagingProvider. */
function createWhatsAppProvider(): MessagingProvider {
  const client = getMessagingClient();
  return {
    name: 'whatsapp',
    async init() {
      await client.init();
    },
    async sendMessage(jid, text) {
      await client.sendMessage(jid, text);
    },
    async setTyping(jid, typing) {
      await client.setTyping(jid, typing);
    },
    async getNewMessages(jids, since, botName) {
      return client.getNewMessages(jids, since, botName);
    },
    async getMessagesSince(chatId, since, botName) {
      return client.getMessagesSince(chatId, since, botName);
    },
    async getStatus() {
      return client.getStatus();
    },
    async listChats() {
      return client.listChats();
    },
    async logout() {
      return client.logout();
    },
  };
}

/** Register outbound messaging and tools without starting an inbound poller. */
export function registerWhatsAppMessaging(): MessagingProvider {
  const provider = createWhatsAppProvider();
  setMessagingProvider(provider);
  TOOLSET_MODULES.project_setup = [
    ...TOOLSET_MODULES.project_setup.filter(
      (tool) => tool.name !== registerGroupTool.name,
    ),
    registerGroupTool,
  ];
  return provider;
}

const whatsappModule: CarapaModule = {
  name: 'whatsapp',

  isEnabled() {
    return ENABLE_WHATSAPP;
  },

  async init() {
    // Ensure the WhatsApp messaging stack is running
    await ensureWaLinkStack();

    // Create and register the messaging provider
    const provider = registerWhatsAppMessaging();

    // Initialize messaging connection (non-blocking — app works without it)
    provider
      .init()
      .then(() => {
        // Start message loop once messaging is available
        startMessageLoop();
      })
      .catch((err) =>
        logger.warn(
          { err },
          'Messaging connection failed, running without messaging',
        ),
      );
  },

  async shutdown() {
    await stopMessageLoop();
    setMessagingProvider(null);
    TOOLSET_MODULES.project_setup = TOOLSET_MODULES.project_setup.filter(
      (tool) => tool.name !== registerGroupTool.name,
    );
  },

  getConfigFlags() {
    return { enableWhatsApp: true };
  },

  getRouter() {
    return whatsappRoutes;
  },
};

export default whatsappModule;
