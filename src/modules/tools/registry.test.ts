import { expect, spyOn, test } from 'bun:test';
import * as stateManager from '../../state-manager.js';
import webModule from '../web/index.js';
import { getOpenAITools } from './index.js';
import { loadToolsetTool } from './core-tools.js';
import { TOOLSET_MODULES, getActiveToolsets } from './registry.js';

test('web module startup advertises callable tools without exporting its factory to DirectLLM', async () => {
  const previousWebTools = TOOLSET_MODULES.web;
  try {
    await webModule.init!();

    const tools = getOpenAITools({ group_folder: 'tool-registration-test' });
    const webTools = tools.filter((tool) =>
      TOOLSET_MODULES.web.some((web) => web.name === tool.function.name),
    );
    expect(webTools.map((tool) => tool.function.name).sort()).toEqual([
      'web_fetch_image',
      'web_search',
      'web_view',
    ]);
  } finally {
    TOOLSET_MODULES.web = previousWebTools;
  }
});

test('strict privacy mode hides remote-egress toolsets and blocks load_toolset', async () => {
  const lookup = spyOn(stateManager, 'getGroupByFolder').mockImplementation(
    (folder: string) =>
      ({
        settings: {
          privacyMode: folder === 'privacy-strict' ? 'strict' : 'off',
        },
      }) as any,
  );
  try {
    const strict = 'privacy-strict';
    const off = 'privacy-off';

    expect(getActiveToolsets(strict)).not.toContain('web');
    expect(getActiveToolsets(strict)).not.toContain('images');
    expect(getActiveToolsets(off)).toEqual(
      expect.arrayContaining(['web', 'images']),
    );

    await loadToolsetTool.handler({ toolsets: ['web', 'images'] }, {} as any, {
      group_folder: strict,
    });
    expect(getActiveToolsets(strict)).not.toContain('web');
    expect(getActiveToolsets(strict)).not.toContain('images');
  } finally {
    lookup.mockRestore();
  }
});
