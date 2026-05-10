import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface DevEcoEnv {
  devecoHome: string;
  sdkPath: string;
  aceServerPath: string;
  nodeBin: string;
  hvigorPath: string;
}

const PLATFORM = process.platform;
const IS_MAC = PLATFORM === 'darwin';
const IS_WIN = PLATFORM === 'win32';

const DEFAULT_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/DevEco-Studio.app',
    '/Applications/DevEco Studio.app',
    path.join(os.homedir(), 'Applications', 'DevEco-Studio.app'),
    path.join(os.homedir(), 'Applications', 'DevEco Studio.app'),
  ],
  linux: [
    '/opt/DevEco-Studio',
    path.join(os.homedir(), 'DevEco-Studio'),
  ],
  win32: [
    'D:/Application/Huawei/DevEco Studio',
    'C:/Program Files/Huawei/DevEco Studio',
    path.join(os.homedir(), 'AppData', 'Local', 'Huawei', 'DevecoStudio'),
  ],
};

const ENV_HINT_KEYS = ['ARKTS_DEVECO_HOME', 'ARKTS_DEVELOPER_PATH', 'DEVECO_HOME', 'DEVECO_PATH'];

function pickExplicitEnvHome(): string | null {
  for (const key of ENV_HINT_KEYS) {
    const candidate = process.env[key];
    if (candidate && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function resolveContentsPath(rawPath: string): string {
  const lower = rawPath.toLowerCase();
  if (lower.endsWith('.app')) {
    return path.join(rawPath, 'Contents');
  }
  if (fs.existsSync(path.join(rawPath, 'plugins'))) {
    return rawPath;
  }
  if (path.basename(rawPath) === 'Contents') {
    return rawPath;
  }
  return path.join(rawPath, 'Contents');
}

function validateDevEcoHome(candidate: string): DevEcoEnv | null {
  const contentsPath = resolveContentsPath(candidate);
  const aceServerPath = path.join(contentsPath, 'plugins', 'openharmony', 'ace-server', 'out', 'index.js');
  if (!fs.existsSync(aceServerPath)) return null;

  const sdkPkg = path.join(contentsPath, 'sdk', 'default', 'sdk-pkg.json');
  if (!fs.existsSync(sdkPkg)) return null;

  const nodeName = IS_WIN ? 'node.exe' : 'node';
  const nodeBinDir = IS_WIN ? '' : 'bin';
  const nodeBin = path.join(contentsPath, 'tools', 'node', nodeBinDir, nodeName);
  const hvigorPath = path.join(contentsPath, 'tools', 'hvigor', 'bin', 'hvigorw.js');

  return {
    devecoHome: contentsPath,
    sdkPath: path.join(contentsPath, 'sdk', 'default'),
    aceServerPath,
    nodeBin,
    hvigorPath,
  };
}

export function findDevEcoEnv(): DevEcoEnv | null {
  const envHome = pickExplicitEnvHome();
  if (envHome) {
    const result = validateDevEcoHome(envHome);
    if (result) return result;
    // When DEVECO_HOME is explicitly set but invalid, don't fall through to defaults
    return null;
  }

  const defaults = DEFAULT_PATHS[PLATFORM] || DEFAULT_PATHS.linux;
  for (const p of defaults) {
    const result = validateDevEcoHome(p);
    if (result) return result;
  }

  return null;
}
