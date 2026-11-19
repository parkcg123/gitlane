import type { UnmergedEntry } from './git';
import type { PendingConflictContext } from './workflow';

export type ConflictKind = 'UU' | 'AA' | 'DU' | 'UD' | 'AU' | 'UA' | 'DD' | 'OTHER';

export interface ConflictFileItem {
  path: string;
  status: 'unresolved' | 'resolved';
  conflictKind?: ConflictKind;
  conflictKindLabel?: string;
}

export interface ConflictSideLabels {
  oursLabel: string;
  theirsLabel: string;
  oursTooltip: string;
  theirsTooltip: string;
}

export interface ConflictPanelState {
  merging: boolean;
  targetBranch: string;
  sourceBranch: string;
  returnBranch: string;
  kind: 'mergeToDevelop' | 'releaseToMaster' | 'external';
  deleteSourceOnComplete: boolean;
  labels: ConflictSideLabels;
  files: ConflictFileItem[];
  unresolvedCount: number;
  resolvedCount: number;
  totalCount: number;
  canComplete: boolean;
}

const KNOWN_CONFLICT_KINDS = new Set<ConflictKind>([
  'UU',
  'AA',
  'DU',
  'UD',
  'AU',
  'UA',
  'DD',
]);

export function toConflictKind(xy: string): ConflictKind {
  return KNOWN_CONFLICT_KINDS.has(xy as ConflictKind) ? (xy as ConflictKind) : 'OTHER';
}

export function formatConflictKindLabel(xy: string): string {
  switch (xy) {
    case 'UU':
      return '양쪽 수정';
    case 'AA':
      return '양쪽 추가';
    case 'DU':
      return '대상 삭제 / 병합 수정';
    case 'UD':
      return '대상 수정 / 병합 삭제';
    case 'AU':
      return '대상 추가';
    case 'UA':
      return '병합 추가';
    case 'DD':
      return '양쪽 삭제';
    default:
      return '충돌';
  }
}

export function getConflictSideLabels(
  context: PendingConflictContext | undefined,
  currentBranch: string | null
): ConflictSideLabels {
  if (context?.kind === 'mergeToDevelop') {
    return {
      oursLabel: `${context.targetBranch} 유지 (스테이지)`,
      theirsLabel: `${context.sourceBranch} 적용 (내 작업)`,
      oursTooltip: `스테이지(${context.targetBranch}) 브랜치의 내용을 그대로 유지하고 Stage 처리합니다 (--ours).`,
      theirsTooltip: `내 작업(${context.sourceBranch}) 브랜치의 내용으로 덮어쓰고 Stage 처리합니다 (--theirs).`,
    };
  }

  if (context?.kind === 'releaseToMaster') {
    return {
      oursLabel: `${context.targetBranch} 유지 (운영)`,
      theirsLabel: `${context.sourceBranch} 적용 (스테이지)`,
      oursTooltip: `운영(${context.targetBranch}) 브랜치의 내용을 유지하고 Stage 처리합니다 (--ours).`,
      theirsTooltip: `스테이지(${context.sourceBranch}) 브랜치의 내용으로 적용하고 Stage 처리합니다 (--theirs).`,
    };
  }

  const target = currentBranch ?? '현재 브랜치';
  return {
    oursLabel: '현재 브랜치 유지 (Ours)',
    theirsLabel: '병합 브랜치 적용 (Theirs)',
    oursTooltip: `${target}의 현재 내용을 유지하고 Stage 처리합니다 (--ours).`,
    theirsTooltip: '병합 중인 브랜치의 내용으로 적용하고 Stage 처리합니다 (--theirs).',
  };
}

export function buildConflictPanelState(params: {
  merging: boolean;
  currentBranch: string | null;
  context: PendingConflictContext | undefined;
  unmergedEntries: UnmergedEntry[];
}): ConflictPanelState {
  const { merging, currentBranch, context, unmergedEntries } = params;
  const unmergedMap = new Map<string, UnmergedEntry>();
  for (const entry of unmergedEntries) {
    unmergedMap.set(entry.path, entry);
  }

  const allPaths = new Set<string>(context?.initialConflictedFiles ?? []);
  for (const entry of unmergedEntries) {
    allPaths.add(entry.path);
  }

  const files: ConflictFileItem[] = Array.from(allPaths).map((filePath) => {
    const unmerged = unmergedMap.get(filePath);
    if (unmerged) {
      return {
        path: filePath,
        status: 'unresolved',
        conflictKind: toConflictKind(unmerged.xy),
        conflictKindLabel: formatConflictKindLabel(unmerged.xy),
      };
    }
    return {
      path: filePath,
      status: 'resolved',
    };
  });

  files.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === 'unresolved' ? -1 : 1;
    }
    return a.path.localeCompare(b.path);
  });

  const unresolvedCount = files.filter((f) => f.status === 'unresolved').length;
  const totalCount = files.length;
  const resolvedCount = totalCount - unresolvedCount;

  return {
    merging,
    targetBranch: context?.targetBranch ?? currentBranch ?? '현재 브랜치',
    sourceBranch: context?.sourceBranch ?? '병합 브랜치',
    returnBranch: context?.returnBranch ?? currentBranch ?? '현재 브랜치',
    kind: context?.kind ?? 'external',
    deleteSourceOnComplete: context?.deleteSourceOnComplete ?? false,
    labels: getConflictSideLabels(context, currentBranch),
    files,
    unresolvedCount,
    resolvedCount,
    totalCount,
    canComplete: merging && unresolvedCount === 0,
  };
}
