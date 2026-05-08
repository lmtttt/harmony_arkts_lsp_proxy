import * as path from 'path';
import * as fs from 'fs';
import JSON5 from 'json5';

export interface AceModule {
  moduleName: string;
  modulePath: string;
  deviceType: string[];
  aceLoaderPath: string;
  jsComponentType: number;
  sdkJsPath: string;
  compatibleSdkLevel: string;
  apiType: string;
}

export interface ProjectConfig {
  projectRoot: string;
  rootUri: string;
  lspServerWorkspacePath: string;
  modules: AceModule[];
}

export function extractCompatibleSdkLevel(version: string): string {
  const match = version.match(/\((\d+)\)/);
  return match ? match[1] : '12';
}

function constructModule(
  name: string,
  srcPath: string,
  projectRoot: string,
  sdkPath: string,
  compatibleSdkLevel: string,
): AceModule {
  const modulePath = path.resolve(projectRoot, srcPath);
  const deviceType = 'phone';
  const sdkJsPath = path.join(sdkPath, 'js', 'api', deviceType) + path.sep;
  const aceLoaderPath = path.join(sdkPath, 'js', 'framework', deviceType, 'ace-loader');

  return {
    moduleName: name,
    modulePath,
    deviceType: [deviceType],
    aceLoaderPath,
    jsComponentType: 0,
    sdkJsPath,
    compatibleSdkLevel,
    apiType: 'Stage',
  };
}

export function findProjectRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(current, 'build-profile.json5'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function parseProject(projectRoot: string, sdkPath: string): ProjectConfig | null {
  const profilePath = path.join(projectRoot, 'build-profile.json5');
  if (!fs.existsSync(profilePath)) return null;

  try {
    const content = fs.readFileSync(profilePath, 'utf-8');
    const profile = JSON5.parse(content);

    const products = profile.app?.products || [];
    const firstProduct = products[0];
    const compatibleSdkLevel = firstProduct?.compatibleSdkVersion
      ? extractCompatibleSdkLevel(firstProduct.compatibleSdkVersion)
      : '12';

    const rawModules = profile.modules || [];
    const modules: AceModule[] = [];

    for (const mod of rawModules) {
      if (!mod.name || !mod.srcPath) {
        process.stderr.write(`[arkts-lsp] Skipping module with missing name or srcPath\n`);
        continue;
      }
      modules.push(constructModule(mod.name, mod.srcPath, projectRoot, sdkPath, compatibleSdkLevel));
    }

    if (modules.length === 0) return null;

    return {
      projectRoot,
      rootUri: 'file://' + projectRoot,
      lspServerWorkspacePath: projectRoot,
      modules,
    };
  } catch (e) {
    process.stderr.write(`[arkts-lsp] Failed to parse build-profile.json5:\n`);
    if (e instanceof Error) {
      process.stderr.write(e.stack + '\n');
    } else {
      process.stderr.write(String(e) + '\n');
    }
    return null;
  }
}
