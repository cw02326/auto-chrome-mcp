export { detectChromeBinary, getEnvironmentInfo, type ChromeBinary } from './detect-binary.js';

export { detectChromeUserDataDir } from './detect-profile.js';

export { ensurePortFree, isPortFree, isChromeCdpEndpoint } from './ensure-port-free.js';

export {
  launchChrome,
  readCdpPort,
  cdpPortFilePath,
  type LaunchOptions,
  type LaunchResult,
} from './launch.js';
