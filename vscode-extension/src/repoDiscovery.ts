import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DiscoveredRepo {
  root: string;
  label: string;
}

const IGNORED_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  'out',
  'out-test',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  '.next',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
]);

export function normalizeRepoPath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function hasGitMarker(dirPath: string): boolean {
  try {
    return fs.existsSync(path.join(dirPath, '.git'));
  } catch {
    return false;
  }
}

export function findGitRootForPath(startPath: string): string | null {
  let current: string;
  try {
    const resolved = path.resolve(startPath);
    const stat = fs.statSync(resolved);
    current = stat.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    current = path.dirname(path.resolve(startPath));
  }

  for (let depth = 0; depth < 64; depth++) {
    if (hasGitMarker(current)) {
      return normalizeRepoPath(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

export function scanNestedGitRepos(baseDir: string, maxDepth = 2): string[] {
  if (!baseDir) {
    return [];
  }

  let normalizedBase: string;
  try {
    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
      return [];
    }
    normalizedBase = normalizeRepoPath(baseDir);
  } catch {
    return [];
  }

  const found = new Set<string>();
  const enclosingRoot = findGitRootForPath(normalizedBase);
  if (enclosingRoot) {
    found.add(enclosingRoot);
  }

  const walk = (dir: string, depth: number): void => {
    if (depth >= maxDepth) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        continue;
      }
      if (IGNORED_SCAN_DIRS.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      const childPath = path.join(dir, entry.name);
      if (hasGitMarker(childPath)) {
        found.add(normalizeRepoPath(childPath));
      }
      walk(childPath, depth + 1);
    }
  };

  walk(normalizedBase, 0);
  return Array.from(found);
}

function relativeLabelFromWorkspaces(
  repoRoot: string,
  normalizedWorkspaces: string[]
): string | null {
  for (const ws of normalizedWorkspaces) {
    if (repoRoot === ws) {
      return path.basename(repoRoot) || repoRoot;
    }
    if (repoRoot.startsWith(ws + path.sep)) {
      const rel = path.relative(ws, repoRoot).split(path.sep).join('/');
      if (rel.length > 0) {
        return rel;
      }
    }
  }
  return null;
}

function tailSegments(targetPath: string, count: number): string {
  const parts = targetPath.split(path.sep).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return targetPath;
  }
  return parts.slice(-count).join('/');
}

export function buildRepoLabels(
  roots: Iterable<string>,
  workspaceRoots: Iterable<string> = []
): DiscoveredRepo[] {
  const uniqueRoots = new Set<string>();
  for (const root of roots) {
    if (!root) {
      continue;
    }
    try {
      if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
        uniqueRoots.add(normalizeRepoPath(root));
      }
    } catch {
      // Ignore vanished repository directories.
    }
  }

  const normalizedWorkspaces = Array.from(workspaceRoots)
    .filter((ws) => Boolean(ws))
    .map((ws) => normalizeRepoPath(ws))
    .sort((a, b) => b.length - a.length);

  const rootList = Array.from(uniqueRoots);
  const labels = new Map<string, string>();
  for (const root of rootList) {
    labels.set(root, path.basename(root) || root);
  }

  // Disambiguate colliding basenames using workspace-relative paths first, then parent segments.
  const findCollisions = (): Map<string, string[]> => {
    const byLabel = new Map<string, string[]>();
    for (const root of rootList) {
      const label = labels.get(root)!;
      const list = byLabel.get(label) ?? [];
      list.push(root);
      byLabel.set(label, list);
    }
    return byLabel;
  };

  for (const [, collidingRoots] of findCollisions()) {
    if (collidingRoots.length <= 1) {
      continue;
    }
    const candidates = collidingRoots.map((root) => ({
      root,
      rel: relativeLabelFromWorkspaces(root, normalizedWorkspaces),
    }));
    const uniqueRels = new Set(candidates.map((c) => c.rel).filter(Boolean));
    if (candidates.every((c) => c.rel !== null) && uniqueRels.size === candidates.length) {
      for (const candidate of candidates) {
        labels.set(candidate.root, candidate.rel!);
      }
      continue;
    }

    let depth = 2;
    let remaining = collidingRoots;
    while (remaining.length > 1 && depth <= 8) {
      const nextByLabel = new Map<string, string[]>();
      for (const root of remaining) {
        const candidateLabel = tailSegments(root, depth);
        labels.set(root, candidateLabel);
        const list = nextByLabel.get(candidateLabel) ?? [];
        list.push(root);
        nextByLabel.set(candidateLabel, list);
      }
      remaining = [];
      for (const group of nextByLabel.values()) {
        if (group.length > 1) {
          remaining.push(...group);
        }
      }
      depth++;
    }
    for (const root of remaining) {
      labels.set(root, root);
    }
  }

  return rootList
    .map((root) => ({ root, label: labels.get(root)! }))
    .sort((a, b) => {
      const byLabel = a.label.localeCompare(b.label);
      return byLabel !== 0 ? byLabel : a.root.localeCompare(b.root);
    });
}

export function findContainingRepo(
  filePath: string | null | undefined,
  repos: DiscoveredRepo[]
): DiscoveredRepo | undefined {
  if (!filePath || repos.length === 0) {
    return undefined;
  }

  const normalizedFile = normalizeRepoPath(filePath);
  let bestMatch: DiscoveredRepo | undefined;
  for (const repo of repos) {
    const isExact = normalizedFile === repo.root;
    const isInside = normalizedFile.startsWith(repo.root + path.sep);
    if ((isExact || isInside) && (!bestMatch || repo.root.length > bestMatch.root.length)) {
      bestMatch = repo;
    }
  }
  return bestMatch;
}
