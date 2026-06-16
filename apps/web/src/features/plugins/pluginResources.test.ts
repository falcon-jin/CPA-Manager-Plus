import { describe, expect, it } from 'vitest';
import type { PluginListEntry } from '@/types';
import {
  collectPluginResourceEntries,
  isPluginManagementNavVisible,
  isPluginResourceNavVisible,
} from './pluginResources';

const createPlugin = (patch: Partial<PluginListEntry> = {}): PluginListEntry => ({
  id: 'demo-plugin',
  path: 'plugins/demo-plugin.so',
  configured: true,
  registered: true,
  enabled: true,
  effectiveEnabled: true,
  supportsOAuth: false,
  logo: '',
  configFields: [],
  menus: [
    {
      path: '/v0/resource/plugins/demo-plugin/page',
      menu: 'Demo Plugin',
      description: 'Demo plugin page',
    },
  ],
  metadata: {
    name: 'Demo Plugin',
    version: '1.0.0',
    author: 'router-for-me',
    githubRepository: 'router-for-me/demo-plugin',
    logo: '',
    configFields: [],
  },
  ...patch,
});

describe('plugin resource helpers', () => {
  it('keeps the plugin management nav visible whenever the backend supports plugins', () => {
    expect(isPluginManagementNavVisible({ supportsPlugin: true })).toBe(true);
    expect(isPluginManagementNavVisible({ supportsPlugin: false })).toBe(false);
  });

  it('shows plugin resource nav only when supported and globally enabled', () => {
    expect(
      isPluginResourceNavVisible({ supportsPlugin: true, pluginsEnabled: true })
    ).toBe(true);
    expect(
      isPluginResourceNavVisible({ supportsPlugin: true, pluginsEnabled: false })
    ).toBe(false);
    expect(isPluginResourceNavVisible({ supportsPlugin: true })).toBe(false);
    expect(
      isPluginResourceNavVisible({ supportsPlugin: false, pluginsEnabled: true })
    ).toBe(false);
  });

  it('collects only effective plugin menus with resource paths', () => {
    const entries = collectPluginResourceEntries([
      createPlugin(),
      createPlugin({
        id: 'inactive-plugin',
        effectiveEnabled: false,
        menus: [
          {
            path: '/v0/resource/plugins/inactive/page',
            menu: 'Inactive',
            description: '',
          },
        ],
      }),
      createPlugin({
        id: 'empty-menu-plugin',
        menus: [
          {
            path: '',
            menu: 'Empty Menu',
            description: '',
          },
        ],
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      pluginID: 'demo-plugin',
      pluginTitle: 'Demo Plugin',
      label: 'Demo Plugin',
      route: '/plugin-pages/demo-plugin/0',
    });
  });
});
