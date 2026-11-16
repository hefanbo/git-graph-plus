import type { Ref } from '../types';

/** One visual badge for a branch name, merged across every source that has it. */
export interface BranchBadgeGroup {
  /** Branch name shared by all sources in this group. */
  name: string;
  /** Remotes that have this branch, alphabetically sorted. */
  remotes: string[];
  /** A local branch (or HEAD) with this name survived the filter. */
  hasLocal: boolean;
  /** This group is the checked-out branch. */
  isHead: boolean;
  /** The local branch is checked out in a linked worktree. */
  isWorktree: boolean;
  /** Detached HEAD (`head` ref named HEAD), which is not a real local branch. */
  isDetachedHead: boolean;
}

/** Badges for one commit, in render order: tags first, then branch groups, then stashes. */
export interface RefBadges {
  tags: Ref[];
  branches: BranchBadgeGroup[];
  stashes: Ref[];
}

interface BuildOptions {
  /** Active remote filter: remote names plus `local`; empty means no filter. */
  remoteFilter?: readonly string[];
  /** Branch names checked out in linked worktrees (green + worktree icon). */
  worktreeBranches?: ReadonlySet<string>;
}

/**
 * Group a commit's refs into the badge model.
 *
 * Branch/head/remote-branch refs merge by branch name: one badge lists every
 * remote (alphabetically) that has that branch, plus a local marker when a
 * local branch of the same name is present. The remote filter is applied to the
 * sources first, so a filtered-out local branch turns the badge into a
 * remote-only one (and a fully filtered group disappears). Tags and stashes are
 * never grouped and keep their input order.
 */
export function buildRefBadges(
  refs: readonly Ref[],
  options: BuildOptions = {},
): RefBadges {
  const remoteFilter = options.remoteFilter ?? [];
  const worktreeBranches = options.worktreeBranches ?? new Set<string>();
  const includeLocal = remoteFilter.length === 0 || remoteFilter.includes('local');

  const groups = new Map<string, BranchBadgeGroup>();
  const tags: Ref[] = [];
  const stashes: Ref[] = [];

  const groupFor = (name: string): BranchBadgeGroup => {
    let group = groups.get(name);
    if (!group) {
      group = { name, remotes: [], hasLocal: false, isHead: false, isWorktree: false, isDetachedHead: false };
      groups.set(name, group);
    }
    return group;
  };

  for (const ref of refs) {
    switch (ref.type) {
      case 'working-dir':
        break;
      case 'tag':
        tags.push(ref);
        break;
      case 'stash':
        stashes.push(ref);
        break;
      case 'branch':
      case 'head': {
        if (!includeLocal) break;
        const group = groupFor(ref.name);
        group.hasLocal = true;
        if (ref.type === 'head') group.isHead = true;
        if (worktreeBranches.has(ref.name)) group.isWorktree = true;
        if (ref.type === 'head' && ref.name === 'HEAD') group.isDetachedHead = true;
        break;
      }
      case 'remote-branch': {
        if (ref.name === 'HEAD') break;
        if (remoteFilter.length > 0 && (!ref.remote || !remoteFilter.includes(ref.remote))) break;
        if (!ref.remote) break;
        const group = groupFor(ref.name);
        if (!group.remotes.includes(ref.remote)) group.remotes.push(ref.remote);
        break;
      }
    }
  }

  for (const group of groups.values()) {
    group.remotes.sort((a, b) => a.localeCompare(b));
  }
  const branches = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));

  return { tags, branches, stashes };
}
