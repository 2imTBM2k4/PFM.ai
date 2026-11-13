const {
  withPodfileProperties,
  withXcodeProject,
} = require('expo/config-plugins');

/** Sets the iOS version floor for both generated pods and application targets. */
module.exports = function withIos26(config) {
  config = withPodfileProperties(config, (mod) => {
    mod.modResults['ios.deploymentTarget'] = '26.0';
    return mod;
  });
  return withXcodeProject(config, (mod) => {
    const configurations = mod.modResults.pbxXCBuildConfigurationSection();
    for (const value of Object.values(configurations)) {
      if (value && typeof value === 'object' && value.buildSettings) {
        value.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '26.0';
      }
    }
    return mod;
  });
};
