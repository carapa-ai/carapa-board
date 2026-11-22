/**
 * Module registry — explicit registration, not dynamic discovery.
 *
 * Core calls registerModule() for each known module at boot, then uses
 * the aggregate helpers to init/shutdown/register tools/mount routes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Router } from 'express';
import type { McpServerDeps } from '../mcp/auth.js';
import type { CarapaModule } from './types.js';
import { logger } from '../logger.js';

const modules: CarapaModule[] = [];

export function registerModule(mod: CarapaModule): void {
  modules.push(mod);
}

function getEnabledModules(): CarapaModule[] {
  return modules.filter((m) => m.isEnabled());
}

export async function initModules(): Promise<void> {
  for (const mod of getEnabledModules()) {
    if (mod.init) {
      try {
        await mod.init();
        logger.info({ module: mod.name }, 'Module initialized');
      } catch (err) {
        logger.warn(
          { module: mod.name, err },
          'Module init failed — continuing without it',
        );
      }
    }
  }
}

export async function shutdownModules(): Promise<void> {
  for (const mod of getEnabledModules()) {
    if (mod.shutdown) {
      try {
        await mod.shutdown();
      } catch (err) {
        logger.warn({ module: mod.name, err }, 'Module shutdown error');
      }
    }
  }
}

export function registerModuleTools(
  server: McpServer,
  deps: McpServerDeps,
  scope?: any,
): void {
  for (const mod of getEnabledModules()) {
    if (mod.registerTools) {
      mod.registerTools(server, deps, scope);
    }
  }
}

export function getModuleRouters(): Router[] {
  return getEnabledModules()
    .filter((m) => m.getRouter)
    .map((m) => m.getRouter!());
}

export function getModuleConfigFlags(): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  for (const mod of getEnabledModules()) {
    if (mod.getConfigFlags) {
      Object.assign(flags, mod.getConfigFlags());
    }
  }
  return flags;
}
