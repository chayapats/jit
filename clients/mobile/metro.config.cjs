const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

// Shared Jit modules must resolve the same React/native packages as the authored app.
const projectRoot = __dirname;
const repositoryRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);
config.watchFolders = ["src/i18n", "src/s16/client", "src/s16/mobile", "src/s16/voice"].map(directory => path.join(repositoryRoot, directory));
config.resolver.disableHierarchicalLookup = true;
config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules")];
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const previous = config.resolver.blockList;
config.resolver.blockList = [ ...(Array.isArray(previous) ? previous : previous ? [previous] : []), ...[".local", "ios", "android", "dist"].map(directory => new RegExp("^" + escaped(path.join(projectRoot, directory)) + "(?:/|$)")) ];
module.exports = config;
