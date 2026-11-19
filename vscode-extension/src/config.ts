import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FlowConfig {
  useDevelopBranch: boolean;
  developBranch: string;
  masterBranch: string;
  remote: string;
  dateFormat: 'YYYYMMDD';
  separator: string;
  returnToDevelopAfterRelease: boolean;
  useNoFastForwardMerge: boolean;
}

export const CONFIG_FILENAME = '.gitlane.json';

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  useDevelopBranch: true,
  developBranch: 'develop',
  masterBranch: 'master',
  remote: 'origin',
  dateFormat: 'YYYYMMDD',
  separator: '_',
  returnToDevelopAfterRelease: true,
  useNoFastForwardMerge: true,
};

export interface LoadedConfigResult {
  config: FlowConfig;
  warning?: string;
}

export function getTaskBaseBranch(
  config: Pick<FlowConfig, 'useDevelopBranch' | 'developBranch' | 'masterBranch'>
): string {
  return config.useDevelopBranch ? config.developBranch : config.masterBranch;
}

function pickNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function mergePartialConfig(
  base: FlowConfig,
  overrides: Partial<Record<keyof FlowConfig, unknown>>
): FlowConfig {
  return {
    useDevelopBranch:
      typeof overrides.useDevelopBranch === 'boolean'
        ? overrides.useDevelopBranch
        : base.useDevelopBranch,
    developBranch: pickNonEmptyString(overrides.developBranch) ?? base.developBranch,
    masterBranch: pickNonEmptyString(overrides.masterBranch) ?? base.masterBranch,
    remote: pickNonEmptyString(overrides.remote) ?? base.remote,
    dateFormat: overrides.dateFormat === 'YYYYMMDD' ? 'YYYYMMDD' : base.dateFormat,
    separator: pickNonEmptyString(overrides.separator) ?? base.separator,
    returnToDevelopAfterRelease:
      typeof overrides.returnToDevelopAfterRelease === 'boolean'
        ? overrides.returnToDevelopAfterRelease
        : base.returnToDevelopAfterRelease,
    useNoFastForwardMerge:
      typeof overrides.useNoFastForwardMerge === 'boolean'
        ? overrides.useNoFastForwardMerge
        : base.useNoFastForwardMerge,
  };
}

/**
 * Loads repository configuration from `.gitlane.json` (highest priority),
 * falling back to IDE overrides and built-in defaults.
 */
export function loadRepoConfig(
  repoRoot: string,
  ideOverrides?: Partial<FlowConfig>
): LoadedConfigResult {
  const withIde = ideOverrides
    ? mergePartialConfig(DEFAULT_FLOW_CONFIG, ideOverrides)
    : { ...DEFAULT_FLOW_CONFIG };

  const configPath = path.join(repoRoot, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    return { config: withIde };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        config: withIde,
        warning: `${CONFIG_FILENAME} 형식이 올바른 JSON 객체가 아닙니다. 기본 설정을 사용합니다.`,
      };
    }

    return {
      config: mergePartialConfig(withIde, parsed as Partial<Record<keyof FlowConfig, unknown>>),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      config: withIde,
      warning: `${CONFIG_FILENAME} 파일을 읽는 중 오류가 발생했습니다 (${message}). 기본 설정을 사용합니다.`,
    };
  }
}
