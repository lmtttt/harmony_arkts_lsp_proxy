import * as path from 'path';
import * as fs from 'fs';
import JSON5 from 'json5';
import { pathToFileURL } from 'node:url';
import { toWindowsPath } from './env';

export interface AceModule {
  moduleName: string;
  modulePath: string;
  deviceType: Array<number | string>;
  aceLoaderPath: string;
  jsComponentType: number | 'declarative';
  sdkJsPath: string;
  compatibleSdkLevel: string;
  compatibleSdkVersion: string;
  apiType: string;
  packageManagerType?: string;
  compileSdkLevel?: string;
  compileSdkVersion?: string;
  compileSdkType?: string;
  runtimeOs?: string;
  moduleType?: string;
  compileMode?: string;
  syscap?: string[];
  moduleDependencies?: string[];
  permissions?: string[];
  packageName?: string;
}

export interface ProjectConfig {
  projectRoot: string;
  rootUri: string;
  lspServerWorkspacePath: string;
  projectType: string;
  modules: AceModule[];
}

interface BuildProfile {
  app?: {
    products?: Array<Record<string, unknown>>;
    minAPIVersion?: unknown;
    targetAPIVersion?: unknown;
    compileSdkType?: string;
    runtimeOS?: string;
    compatibleDeviceType?: unknown;
  };
  modules?: Array<Record<string, unknown>>;
}

interface ModuleJson {
  module?: {
    name?: string;
    type?: string;
    deviceTypes?: unknown;
    requestPermissions?: Array<{ name?: string }>;
    moduleDependencies?: string[];
  };
}

interface ProjectParseOptions {
  projectRootHint?: string;
}

interface ProfileProduct {
  compatibleSdkVersion?: unknown;
  compileSdkVersion?: unknown;
  compileSdkType?: unknown;
  runtimeOS?: unknown;
  compatibleDeviceType?: unknown;
  appId?: unknown;
}

const DEFAULT_DEVICE_TYPE = 5;
const UPWARD_SCAN_LIMIT = 12;
const DOWNWARD_SCAN_DEPTH = 4;

const DEVICE_NAME_TO_CODE: Record<string, number> = {
  phone: 5,
  default: 5,
  tablet: 7,
  tv: 1,
  car: 2,
  wearable: 3,
  litewearable: 4,
  '2in1': 8,
  smartvision: 9,
};

const DEVICE_CODE_TO_NAME: Record<number, string> = {
  1: 'tv',
  2: 'car',
  3: 'wearable',
  4: 'liteWearable',
  5: 'phone',
  7: 'tablet',
  8: '2in1',
  9: 'smartVision',
};

const SCAN_EXCLUDES = new Set(['.git', 'dist', 'build', 'node_modules', '.idea', '.vscode']);

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
}

function parseMajorVersion(value: unknown): string {
  if (value == null) return '12';
  const text = String(value).trim();
  if (!text) return '12';
  const apiLevel = text.match(/\((\d+)\)/);
  if (apiLevel) return apiLevel[1];
  const m = text.match(/(\d+)/);
  return m ? m[1] : '12';
}

function parseSemanticVersion(value: unknown): string {
  if (value == null) return '12.0.0';
  const text = String(value).trim().replace(/\([^)]*\)/g, '').trim();
  if (!text) return '12.0.0';
  if (/^\d+$/.test(text)) return `${text}.0.0`;
  const segments = text.split('.').filter(Boolean);
  const major = segments[0] ?? '12';
  const minor = segments[1] ?? '0';
  const patch = segments[2] ?? '0';
  return `${major}.${minor}.${patch}`;
}

function parseDeviceType(value: unknown): number[] {
  if (value == null) return [DEFAULT_DEVICE_TYPE];

  const items = Array.isArray(value) ? value : [value];
  const result = items
    .map((entry) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        return Math.trunc(entry);
      }
      if (typeof entry !== 'string') {
        return DEFAULT_DEVICE_TYPE;
      }
      const name = entry.toLowerCase().replace(/\s+/g, '');
      return DEVICE_NAME_TO_CODE[name] ?? DEVICE_NAME_TO_CODE[name.replace('-', '')] ?? DEFAULT_DEVICE_TYPE;
    })
    .filter((x, i, arr) => Number.isFinite(x) && arr.indexOf(x) === i);

  return result.length > 0 ? result : [DEFAULT_DEVICE_TYPE];
}

function resolveDeviceName(deviceType: number): string {
  return DEVICE_CODE_TO_NAME[deviceType] ?? 'phone';
}

function parseProjectType(_buildProfile: BuildProfile | null): string {
  return 'application';
}

function readJson5(filePath: string): unknown | null {
  if (!isFile(filePath)) return null;
  try {
    return JSON5.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function getProfileProduct(profile: BuildProfile): ProfileProduct {
  const firstProduct = (Array.isArray(profile.app?.products) ? profile.app.products[0] : null) as ProfileProduct | null;
  if (firstProduct && typeof firstProduct === 'object') {
    return firstProduct;
  }
  return {
    compatibleSdkVersion: profile?.app?.minAPIVersion,
    compileSdkVersion: profile?.app?.targetAPIVersion,
    compileSdkType: profile?.app?.compileSdkType,
    runtimeOS: profile?.app?.runtimeOS,
    compatibleDeviceType: profile?.app?.compatibleDeviceType,
  };
}

function buildModuleConfig(
  modulePath: string,
  sdkPath: string,
  product: ProfileProduct,
  buildProfile: BuildProfile,
  fallbackName: string,
): AceModule {
  const moduleJsonPath = path.join(modulePath, 'src', 'main', 'module.json5');
  const moduleDescriptor = readJson5(moduleJsonPath) as ModuleJson | null;

  const moduleName =
    moduleDescriptor?.module?.name ||
    path.basename(modulePath) ||
    fallbackName ||
    'entry';

  const productDeviceType = parseDeviceType(product.compatibleDeviceType);
  const deviceType = parseDeviceType(moduleDescriptor?.module?.deviceTypes ?? productDeviceType);
  const deviceName = resolveDeviceName(deviceType[0] ?? DEFAULT_DEVICE_TYPE);

  const compatibleSdkVersion = parseMajorVersion(product.compatibleSdkVersion);
  const compileSdkVersion = parseMajorVersion(product.compileSdkVersion ?? buildProfile.app?.targetAPIVersion);

  const permissions = moduleDescriptor?.module?.requestPermissions
    ? moduleDescriptor.module.requestPermissions
        .map((entry) => (typeof entry?.name === 'string' ? entry.name : ''))
        .filter(Boolean)
    : [];

  const moduleDependencies = Array.isArray(moduleDescriptor?.module?.moduleDependencies)
    ? moduleDescriptor.module.moduleDependencies
    : [];

  return {
    moduleName: String(moduleName),
    modulePath,
    deviceType,
    jsComponentType: 'declarative',
    apiType: 'stageMode',
    packageManagerType: 'ohpm',
    compatibleSdkLevel: compatibleSdkVersion,
    compatibleSdkVersion,
    compileSdkLevel: parseMajorVersion(compileSdkVersion),
    compileSdkVersion: parseSemanticVersion(compileSdkVersion),
    compileSdkType: String(product.compileSdkType ?? 'Canary'),
    runtimeOs: String(product.runtimeOS ?? 'OpenHarmony'),
    moduleType: String(moduleDescriptor?.module?.type || 'entry'),
    compileMode: 'esmodule',
    syscap: [],
    moduleDependencies,
    permissions,
    packageName: moduleDescriptor?.module?.name,
    sdkJsPath: path.join(sdkPath, 'openharmony', 'ets', 'api') + path.sep,
    aceLoaderPath: path.join(sdkPath, 'openharmony', 'js', 'build-tools', 'ace-loader'),
  };
}

function readBuildProfile(profilePath: string): BuildProfile | null {
  const parsed = readJson5(profilePath);
  return parsed && typeof parsed === 'object' ? (parsed as BuildProfile) : null;
}

function discoverModulePathsFromProfile(profileModules: Array<Record<string, unknown>>, projectRoot: string): string[] {
  const paths: string[] = [];
  for (const mod of profileModules) {
    const srcPath =
      (typeof mod?.name === 'string' && typeof mod?.srcPath !== 'string')
        ? undefined
        : typeof mod?.srcPath === 'string'
          ? mod.srcPath
          : undefined;

    if (!srcPath) {
      continue;
    }

    const absPath = path.resolve(projectRoot, srcPath);
    if (isDirectory(absPath)) {
      paths.push(absPath);
    }
  }

  return paths;
}

function discoverModulePathsByScan(projectRoot: string): string[] {
  const likelyRoots = ['entry', path.join('entry', 'src', 'main'), path.join('src', 'main')]
    .map((candidate) => path.join(projectRoot, candidate))
    .filter((candidate) => isDirectory(candidate));

  const result = new Set<string>(likelyRoots);

  try {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: projectRoot, depth: 0 }];
    while (queue.length > 0) {
      const state = queue.shift();
      if (!state) break;
      if (state.depth >= DOWNWARD_SCAN_DEPTH) {
        continue;
      }

      const entries = fs.readdirSync(state.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (SCAN_EXCLUDES.has(entry.name)) {
          continue;
        }
        const next = path.join(state.dir, entry.name);
        const moduleJson = path.join(next, 'module.json5');
        const buildProfile = path.join(next, 'build-profile.json5');
        if (isFile(moduleJson) || isFile(buildProfile) && next !== projectRoot) {
          result.add(next);
        }
        if (state.depth + 1 <= DOWNWARD_SCAN_DEPTH) {
          queue.push({ dir: next, depth: state.depth + 1 });
        }
      }
    }
  } catch {
    // ignore unreadable folders
  }

  return Array.from(result);
}

function createDefaultModules(sdkPath: string, projectRoot: string, product: ProfileProduct, buildProfile: BuildProfile): AceModule[] {
  const defaultModulePath = path.join(projectRoot, 'entry');
  const modulePath = isDirectory(defaultModulePath) ? defaultModulePath : projectRoot;
  return [buildModuleConfig(modulePath, sdkPath, product, buildProfile, path.basename(modulePath))];
}

function hasBuildProfile(root: string): boolean {
  return isFile(path.join(root, 'build-profile.json5'));
}

function scanDownForProject(root: string): string | null {
  const q: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (q.length > 0) {
    const item = q.shift();
    if (!item) {
      continue;
    }
    if (hasBuildProfile(item.dir)) {
      return item.dir;
    }
    if (item.depth >= DOWNWARD_SCAN_DEPTH) {
      continue;
    }

    try {
      const entries = fs.readdirSync(item.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || SCAN_EXCLUDES.has(entry.name)) {
          continue;
        }
        q.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 });
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function findProjectRoot(startDir: string, options?: ProjectParseOptions): string | null {
  const hinted = options?.projectRootHint ? path.resolve(options.projectRootHint) : null;
  const candidate = hinted ?? path.resolve(startDir);
  const root = isDirectory(candidate) ? candidate : path.dirname(candidate);

  let current = root;
  for (let i = 0; i < UPWARD_SCAN_LIMIT; i++) {
    if (hasBuildProfile(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return scanDownForProject(root);
}

export function parseProject(projectRoot: string, sdkPath: string): ProjectConfig | null {
  if (!hasBuildProfile(projectRoot)) {
    return null;
  }

  const profilePath = path.join(projectRoot, 'build-profile.json5');
  const profile = readBuildProfile(profilePath);
  if (!profile) {
    return null;
  }

  const product = getProfileProduct(profile);
  const compatibleSdkLevel = parseMajorVersion(product.compatibleSdkVersion ?? profile.app?.minAPIVersion);

  const profileModules = Array.isArray(profile.modules) ? profile.modules.filter((m) => m && typeof m === 'object') : [];
  const discoveredByProfile = discoverModulePathsFromProfile(profileModules as Array<Record<string, unknown>>, projectRoot);

  const discoveredByScan = discoverModulePathsByScan(projectRoot);
  const modulePaths = discoveredByProfile.length > 0 ? discoveredByProfile : discoveredByScan;

  const modules = new Map<string, AceModule>();

  for (const modulePath of modulePaths) {
    const module = buildModuleConfig(modulePath, sdkPath, product, profile, path.basename(modulePath));
    const resolvedPath = path.resolve(modulePath);
    if (!modules.has(resolvedPath)) {
      modules.set(resolvedPath, module);
    }
  }

  if (modules.size === 0) {
    const defaults = createDefaultModules(sdkPath, projectRoot, product, profile);
    defaults.forEach((mod, index) => modules.set(`${mod.modulePath}-${index}`, mod));
  }

  const finalModules = Array.from(modules.values()).map((m) => ({
    ...m,
    compatibleSdkLevel,
    compatibleSdkVersion: compatibleSdkLevel,
    compileSdkLevel: m.compileSdkLevel ?? compatibleSdkLevel,
    compileSdkVersion: m.compileSdkVersion ?? parseSemanticVersion(product.compileSdkVersion ?? profile.app?.targetAPIVersion),
  }));

  return {
    projectRoot,
    rootUri: pathToFileURL(projectRoot).toString(),
    lspServerWorkspacePath: projectRoot,
    projectType: parseProjectType(profile),
    modules: finalModules,
  };
}

export function extractCompatibleSdkLevel(version: string): string {
  return parseMajorVersion(version);
}

export function buildInitializationOptions(project: ProjectConfig): Record<string, unknown> {
  const firstModule = project.modules[0];
  const firstDeviceType =
    firstModule && firstModule.deviceType.length > 0
      ? firstModule.deviceType.map((type) => (typeof type === 'number' ? type : DEFAULT_DEVICE_TYPE))
      : [DEFAULT_DEVICE_TYPE];

  // Convert paths to Windows format for ace-server (WSL2 cross-OS scenario)
  const wsProjectRoot = toWindowsPath(project.projectRoot);
  const wsLspWorkspace = toWindowsPath(project.lspServerWorkspacePath);

  return {
    rootUri: `file:///${wsProjectRoot.replace(/\\/g, '/')}`,
    lspServerWorkspacePath: wsLspWorkspace,
    clientType: 'vscode',
    projectType: project.projectType,
    modules: project.modules.map((mod) => ({
      ...mod,
      modulePath: toWindowsPath(mod.modulePath),
      sdkJsPath: toWindowsPath(mod.sdkJsPath),
      aceLoaderPath: toWindowsPath(mod.aceLoaderPath),
    })),
    isCheckJs: true,
    deviceType: firstDeviceType,
    indexingDataLocation: `${wsProjectRoot}\\.ide-arkts\\indexing`,
    completionSortSetting: { sortMode: 'normal' },
    inlayHintsSetting: {},
    lspMaxOldSpaceSize: 8192,
  };
}

export function normalizeProjectRootCandidate(rawPath: string): string {
  return path.resolve(rawPath);
}
