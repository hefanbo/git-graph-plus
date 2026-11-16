import { describe, it, expect } from 'vitest';
import { buildRefBadges } from '../ref-badges';
import type { Ref } from '../../types';

const ref = (type: Ref['type'], name: string, remote?: string): Ref => ({ type, name, remote });

describe('buildRefBadges', () => {
  it('merges local and same-named remotes, sorting remotes alphabetically', () => {
    const result = buildRefBadges([
      ref('head', 'master'),
      ref('remote-branch', 'master', 'upstream'),
      ref('remote-branch', 'master', 'origin'),
    ]);

    expect(result.branches).toEqual([{
      name: 'master',
      remotes: ['origin', 'upstream'],
      hasLocal: true,
      isHead: true,
      isWorktree: false,
      isDetachedHead: false,
    }]);
  });

  it('keeps remote-only branches, including names with slashes', () => {
    const result = buildRefBadges([ref('remote-branch', 'feat/ui', 'origin')]);

    expect(result.branches).toEqual([{
      name: 'feat/ui',
      remotes: ['origin'],
      hasLocal: false,
      isHead: false,
      isWorktree: false,
      isDetachedHead: false,
    }]);
  });

  it('sorts different branch-name groups alphabetically', () => {
    const result = buildRefBadges([
      ref('branch', 'myfix'),
      ref('remote-branch', 'chore/next', 'origin'),
    ]);

    expect(result.branches.map(g => g.name)).toEqual(['chore/next', 'myfix']);
  });

  it('applies the remote filter to sources before grouping', () => {
    const result = buildRefBadges([
      ref('branch', 'master'),
      ref('remote-branch', 'master', 'origin'),
      ref('remote-branch', 'master', 'upstream'),
    ], { remoteFilter: ['origin'] });

    expect(result.branches).toEqual([{
      name: 'master',
      remotes: ['origin'],
      hasLocal: false,
      isHead: false,
      isWorktree: false,
      isDetachedHead: false,
    }]);
  });

  it('hides a group whose sources are all filtered out', () => {
    const result = buildRefBadges([
      ref('branch', 'local-only'),
      ref('remote-branch', 'remote-only', 'origin'),
    ], { remoteFilter: ['upstream'] });

    expect(result.branches).toEqual([]);
  });

  it('keeps a local-only badge with no sources', () => {
    const result = buildRefBadges([ref('branch', 'fix/user')]);

    expect(result.branches[0]).toMatchObject({
      name: 'fix/user',
      remotes: [],
      hasLocal: true,
    });
  });

  it('marks worktree branches and detached HEAD', () => {
    const worktree = buildRefBadges([ref('branch', 'wt')], {
      worktreeBranches: new Set(['wt']),
    });
    expect(worktree.branches[0].isWorktree).toBe(true);

    const detached = buildRefBadges([ref('head', 'HEAD')]);
    expect(detached.branches[0]).toMatchObject({
      name: 'HEAD',
      hasLocal: true,
      isHead: true,
      isDetachedHead: true,
    });
  });

  it('separates tags and stashes and ignores working-dir / remote HEAD refs', () => {
    const result = buildRefBadges([
      ref('branch', 'main'),
      ref('tag', 'v1'),
      ref('stash', 'stash@{0}'),
      ref('working-dir', 'UNCOMMITTED'),
      ref('remote-branch', 'HEAD', 'origin'),
    ]);

    expect(result.tags.map(r => r.name)).toEqual(['v1']);
    expect(result.stashes.map(r => r.name)).toEqual(['stash@{0}']);
    expect(result.branches.map(g => g.name)).toEqual(['main']);
  });
});
