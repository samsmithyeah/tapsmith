// Metro config for the Tapsmith test app.
//
// `@tapsmith/react-native` is a `file:` dependency, which npm installs as a
// symlink to ../packages/tapsmith-react-native. Metro does not follow symlinks
// outside the project root on its own, so the package folder is added as a
// watch folder — and its own dev-time `react` / `react-native` copies are
// blocked so the app's are the only ones bundled.
const { getDefaultConfig } = require("expo/metro-config")
const path = require("node:path")

const projectRoot = __dirname
const hooksPackage = path.resolve(projectRoot, "../packages/tapsmith-react-native")

const config = getDefaultConfig(projectRoot)

config.watchFolders = [...(config.watchFolders ?? []), hooksPackage]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  ...(config.resolver.nodeModulesPaths ?? []),
]
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  react: path.resolve(projectRoot, "node_modules/react"),
  "react-native": path.resolve(projectRoot, "node_modules/react-native"),
}
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  new RegExp(`${hooksPackage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/node_modules/.*`),
]

module.exports = config
