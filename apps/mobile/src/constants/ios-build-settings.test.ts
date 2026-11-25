import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('iOS 26 build configuration', () => {
  it('sets the version floor for pods and every application build configuration', () => {
    const configurations = {
      debug: {
        buildSettings: {
          IPHONEOS_DEPLOYMENT_TARGET: '16.4',
          PRODUCT_NAME: 'PFM',
        },
      },
      release: { buildSettings: {} },
      comment: 'Release',
    };
    const podProperties: Record<string, string> = { existing: 'preserved' };
    const plugin = { exports: undefined as unknown };
    runInNewContext(
      readFileSync(
        new URL('../../plugins/with-ios-26.cjs', import.meta.url),
        'utf8',
      ),
      {
        module: plugin,
        require: () => ({
          withPodfileProperties: (
            config: object,
            transform: (mod: object) => unknown,
          ) => {
            transform({ modResults: podProperties });
            return config;
          },
          withXcodeProject: (
            config: object,
            transform: (mod: object) => unknown,
          ) => {
            transform({
              modResults: {
                pbxXCBuildConfigurationSection: () => configurations,
              },
            });
            return config;
          },
        }),
      },
    );
    (plugin.exports as (config: object) => void)({});
    expect(podProperties).toEqual({
      existing: 'preserved',
      'ios.deploymentTarget': '26.0',
    });
    expect(configurations.debug.buildSettings).toMatchObject({
      IPHONEOS_DEPLOYMENT_TARGET: '26.0',
      PRODUCT_NAME: 'PFM',
    });
    expect(configurations.release.buildSettings).toMatchObject({
      IPHONEOS_DEPLOYMENT_TARGET: '26.0',
    });
    expect(configurations.comment).toBe('Release');
  });
});
