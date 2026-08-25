import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const BRIDGE_PACKAGE_NAME = 'dsh-vscode-bridge';

export type BridgeInstallationState =
  | 'profile-missing'
  | 'profile-invalid'
  | 'dependency-missing'
  | 'module-missing'
  | 'loader-missing'
  | 'installed';

export interface BridgeInstallationStatus {
  state: BridgeInstallationState;
  profileDir: string;
  dependencyDeclared: boolean;
  dependencySpec?: string;
  modulePresent: boolean;
  loaderConfigured: boolean;
  problem?: string;
}

interface ProfileManifest {
  dependencies?: Record<string, unknown>;
}

/** Resolve the web profile using DSH's `$DSH_HOME`, then `~/.dsh`, precedence. */
export function resolveDshWebProfileDir(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = os.homedir(),
): string {
  const configured = env.DSH_HOME;
  let home = configured !== undefined && configured.trim().length > 0
    ? configured
    : path.join(userHome, '.dsh');
  if (home === '~') home = userHome;
  else if (home.startsWith('~/') || home.startsWith('~\\')) home = path.join(userHome, home.slice(2));
  return path.join(path.resolve(home), 'profiles', 'web');
}

/**
 * Recognize the bridge's loader row without pulling a YAML parser into the
 * extension bundle. Full-line comments are ignored; both block and inline
 * forms documented by DSH are accepted.
 */
export function hasBridgeLoaderEntry(patchText: string): boolean {
  const activeText = patchText
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  if (!/\binsert\s*:/.test(activeText)) return false;
  const value = String.raw`(?:["']${BRIDGE_PACKAGE_NAME}["']|${BRIDGE_PACKAGE_NAME})(?=$|\s|[,}\]])`;
  return new RegExp(String.raw`\bid\s*:\s*${value}`).test(activeText)
    && new RegExp(String.raw`\bname\s*:\s*${value}`).test(activeText);
}

/** Read-only check of the DSH web profile; never initializes or edits it. */
export function detectBridgeInstallation(
  profileDir: string = resolveDshWebProfileDir(),
): BridgeInstallationStatus {
  const manifestPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    return baseStatus('profile-missing', profileDir);
  }

  let manifest: ProfileManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ProfileManifest;
  } catch (error) {
    return {
      ...baseStatus('profile-invalid', profileDir),
      problem: error instanceof Error ? error.message : String(error),
    };
  }

  const rawSpec = manifest.dependencies?.[BRIDGE_PACKAGE_NAME];
  const dependencySpec = typeof rawSpec === 'string' && rawSpec.trim() !== '' ? rawSpec : undefined;
  const dependencyDeclared = dependencySpec !== undefined;
  const modulePresent = fs.existsSync(
    path.join(profileDir, 'node_modules', BRIDGE_PACKAGE_NAME, 'package.json'),
  );
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  let loaderConfigured = false;
  if (fs.existsSync(patchPath)) {
    try {
      loaderConfigured = hasBridgeLoaderEntry(fs.readFileSync(patchPath, 'utf8'));
    } catch {
      // A missing/unreadable loader row is reported as an incomplete install.
    }
  }

  let state: BridgeInstallationState;
  if (!dependencyDeclared) state = 'dependency-missing';
  else if (!modulePresent) state = 'module-missing';
  else if (!loaderConfigured) state = 'loader-missing';
  else state = 'installed';

  return {
    state,
    profileDir,
    dependencyDeclared,
    dependencySpec,
    modulePresent,
    loaderConfigured,
  };
}

export function describeBridgeInstallation(status: BridgeInstallationStatus): string {
  switch (status.state) {
    case 'profile-missing':
      return `NOT INSTALLED (web profile is not initialized: ${status.profileDir})`;
    case 'profile-invalid':
      return `ERROR (cannot read web profile package.json: ${status.problem ?? 'unknown error'})`;
    case 'dependency-missing':
      return `NOT INSTALLED (${BRIDGE_PACKAGE_NAME} is not declared in the web profile)`;
    case 'module-missing':
      return `INCOMPLETE (${status.dependencySpec} is declared but its node_modules package is missing)`;
    case 'loader-missing':
      return `INCOMPLETE (${status.dependencySpec}; loader entry is missing from cordis.patch.yml)`;
    case 'installed':
      return `READY (${status.dependencySpec}; dependency and loader entry found)`;
  }
}

function baseStatus(state: BridgeInstallationState, profileDir: string): BridgeInstallationStatus {
  return {
    state,
    profileDir,
    dependencyDeclared: false,
    modulePresent: false,
    loaderConfigured: false,
  };
}
