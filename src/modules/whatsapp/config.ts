import { parseBooleanEnv } from '../../lib/env.js';

export const ENABLE_WHATSAPP = parseBooleanEnv(process.env.ENABLE_WHATSAPP);

export const MCP_WHATSAPP_STACK =
  process.env.MCP_WHATSAPP_STACK || 'carapa-wa-link';
