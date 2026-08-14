import * as path from 'path';
import type { WorktreeInfo } from '../git/types';
import { logger } from './logger';

/**
 * Resolve the default base folder for new worktrees: `<main-repo>.worktrees`,
 * located beside the resolved main worktree. Falls back to `fallbackPath` if
 * the main worktree cannot be determined.
 */
export async function resolveDefaultWorktreePath(
  gitService: { worktreeList(): Promise<WorktreeInfo[]> },
  fallbackPath: string,
): Promise<string> {
  let baseRepoPath = fallbackPath;
  try {
    const mainWorktree = (await gitService.worktreeList()).find(w => w.isMain);
    if (mainWorktree?.path) {
      baseRepoPath = mainWorktree.path;
    }
  } catch (err) {
    logger.warn('Git Graph+: failed to resolve main worktree path:', err instanceof Error ? err.message : err);
  }
  return path.join(path.dirname(baseRepoPath), `${path.basename(baseRepoPath)}.worktrees`);
}
