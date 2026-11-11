import type { ConfigContext, ExpoConfig } from 'expo/config';

const PLACEHOLDER_IOS_URL_SCHEME =
  'com.googleusercontent.apps.placeholder-replace-with-reversed-ios-client-id';
const GOOGLE_SIGNIN_PLUGIN = '@react-native-google-signin/google-signin';

/**
 * Derives the reversed iOS URL scheme (`com.googleusercontent.apps.<id>`)
 * from an OAuth 2.0 iOS Client ID (`<id>.apps.googleusercontent.com`).
 */
export function deriveGoogleIosUrlScheme(
  iosClientId: string | undefined,
): string | undefined {
  const trimmed = iosClientId?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('com.googleusercontent.apps.')) {
    return trimmed;
  }
  const suffix = '.apps.googleusercontent.com';
  if (trimmed.endsWith(suffix) && trimmed.length > suffix.length) {
    const clientPrefix = trimmed.slice(0, -suffix.length);
    return `com.googleusercontent.apps.${clientPrefix}`;
  }
  return undefined;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim();
  const iosUrlScheme =
    deriveGoogleIosUrlScheme(iosClientId) ?? PLACEHOLDER_IOS_URL_SCHEME;
  const iosBundleId = process.env.EXPO_PUBLIC_IOS_BUNDLE_ID?.trim();

  const existingPlugins = Array.isArray(config.plugins) ? config.plugins : [];
  let updatedGooglePlugin = false;

  const plugins: NonNullable<ExpoConfig['plugins']> = existingPlugins.map(
    (plugin) => {
      if (plugin === GOOGLE_SIGNIN_PLUGIN) {
        updatedGooglePlugin = true;
        return [GOOGLE_SIGNIN_PLUGIN, { iosUrlScheme }];
      }
      if (Array.isArray(plugin) && plugin[0] === GOOGLE_SIGNIN_PLUGIN) {
        updatedGooglePlugin = true;
        const currentOpts =
          plugin[1] && typeof plugin[1] === 'object' ? plugin[1] : {};
        return [
          GOOGLE_SIGNIN_PLUGIN,
          {
            ...currentOpts,
            iosUrlScheme,
          },
        ];
      }
      return plugin;
    },
  );

  if (!updatedGooglePlugin) {
    plugins.push([GOOGLE_SIGNIN_PLUGIN, { iosUrlScheme }]);
  }

  return {
    ...config,
    name: config.name ?? 'PFM.ai',
    slug: config.slug ?? 'pfm-ai',
    ios: {
      ...config.ios,
      bundleIdentifier:
        iosBundleId || config.ios?.bundleIdentifier || 'com.pfmai.app',
    },
    plugins,
  };
};
