import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, currentBranch, head, runGit } from './helpers';

describe('GitService integration — state mutations', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  describe('branch lifecycle', () => {
    it('createBranch from HEAD', async () => {
      commit(repo.path, 'init');
      await svc.createBranch('feature-x');
      const names = (await svc.branches()).map(b => b.name);
      expect(names).toContain('feature-x');
    });

    it('createBranch from arbitrary start point', async () => {
      const c1 = commit(repo.path, 'first');
      commit(repo.path, 'second');
      await svc.createBranch('old-base', c1);
      const branches = await svc.branches();
      const oldBase = branches.find(b => b.name === 'old-base');
      expect(oldBase?.hash).toBe(c1.substring(0, oldBase!.hash.length));
    });

    it('createAndCheckoutBranch switches HEAD', async () => {
      commit(repo.path, 'init');
      await svc.createAndCheckoutBranch('new-branch');
      expect(currentBranch(repo.path)).toBe('new-branch');
    });

    it('createAndCheckoutBranch sets --track when start point is a remote branch', async () => {
      commit(repo.path, 'init');
      // Fake a remote tracking ref so isRemoteBranch('origin/main') returns true.
      runGit(repo.path, ['remote', 'add', 'origin', 'https://example.com/r.git']);
      runGit(repo.path, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

      await svc.createAndCheckoutBranch('local-of-remote', 'origin/main');
      // The new branch should now track origin/main (i.e. have it as upstream).
      const upstream = runGit(repo.path, ['rev-parse', '--abbrev-ref', 'local-of-remote@{upstream}']).trim();
      expect(upstream).toBe('origin/main');
    });

    it('createAndCheckoutBranch with merge=true passes --merge', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      // Dirty the tree so --merge would matter (forces 3-way merge during checkout).
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'two\n');

      // Without --merge, plain checkout -b would refuse with conflicting changes.
      // With --merge, git carries the working-tree changes onto the new branch.
      await svc.createAndCheckoutBranch('topic', undefined, { merge: true });
      expect(currentBranch(repo.path)).toBe('topic');
    });

    it('renameBranch updates the name', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['branch', 'old-name']);
      await svc.renameBranch('old-name', 'new-name');
      const names = (await svc.branches()).map(b => b.name);
      expect(names).toContain('new-name');
      expect(names).not.toContain('old-name');
    });

    it('deleteBranch removes the ref', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['branch', 'temp']);
      await svc.deleteBranch('temp');
      const names = (await svc.branches()).map(b => b.name);
      expect(names).not.toContain('temp');
    });

    it('deleteBranch fails on unmerged branch without force', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['checkout', '-b', 'feature']);
      commit(repo.path, 'feature-only');
      runGit(repo.path, ['checkout', 'main']);

      await expect(svc.deleteBranch('feature')).rejects.toThrow();
    });

    it('deleteBranch with force removes unmerged branch', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['checkout', '-b', 'feature']);
      commit(repo.path, 'feature-only');
      runGit(repo.path, ['checkout', 'main']);

      await svc.deleteBranch('feature', true);
      const names = (await svc.branches()).map(b => b.name);
      expect(names).not.toContain('feature');
    });
  });

  describe('checkout', () => {
    it('switches to existing branch', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['branch', 'other']);
      await svc.checkout('other');
      expect(currentBranch(repo.path)).toBe('other');
    });

    it('checks out detached HEAD at a commit', async () => {
      const c1 = commit(repo.path, 'first');
      commit(repo.path, 'second');
      await svc.checkout(c1);
      expect(currentBranch(repo.path)).toBe('HEAD'); // detached
      expect(head(repo.path)).toBe(c1);
    });

    it('"stash and checkout" sets changes aside instead of carrying them over', async () => {
      // The stash-and-checkout option must leave the working tree clean on the
      // target branch and keep the local changes in the stash for later — it
      // must NOT immediately pop them back (which would make it identical to
      // "keep changes and checkout").
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['branch', 'other']);
      writeFileSync(join(repo.path, 'a.txt'), 'local edit\n');
      expect(await svc.isDirty()).toBe(true);

      await svc.stashSave('Auto-stash before checkout', true);
      await svc.checkout('other');

      expect(currentBranch(repo.path)).toBe('other');
      expect(await svc.isDirty()).toBe(false);              // tree clean, changes set aside
      expect((await svc.stashList()).length).toBe(1);       // changes preserved in the stash
    });
  });

  describe('amendCommit', () => {
    it('rewrites the last commit message when editing', async () => {
      commit(repo.path, 'original message', { 'a.txt': 'a\n' });
      await svc.amendCommit({ message: 'amended message' });
      const tip = (await svc.log()).find(c => c.hash !== 'UNCOMMITTED')!;
      expect(tip.subject).toBe('amended message');
    });

    it('folds staged changes into the last commit and keeps the message', async () => {
      commit(repo.path, 'base', { 'a.txt': 'a\n' });
      writeFileSync(join(repo.path, 'b.txt'), 'b\n');
      runGit(repo.path, ['add', 'b.txt']);
      await svc.amendCommit({ keepMessage: true });
      const files = (await svc.showCommitFiles('HEAD')).map(f => f.path);
      expect(files).toContain('b.txt');
      const tip = (await svc.log()).find(c => c.hash !== 'UNCOMMITTED')!;
      expect(tip.subject).toBe('base');
    });

    it('leaves unstaged changes out of the amend', async () => {
      commit(repo.path, 'base', { 'a.txt': 'a\n' });
      writeFileSync(join(repo.path, 'unstaged.txt'), 'u\n'); // never staged
      await svc.amendCommit({ keepMessage: true });
      const files = (await svc.showCommitFiles('HEAD')).map(f => f.path);
      expect(files).not.toContain('unstaged.txt');
    });

    it('resets the author date to now with resetDate', async () => {
      // helpers commit with GIT_AUTHOR_DATE=2024-01-01.
      commit(repo.path, 'old', { 'a.txt': 'a\n' });
      await svc.amendCommit({ keepMessage: true, resetDate: true });
      const tip = (await svc.log()).find(c => c.hash !== 'UNCOMMITTED')!;
      expect(tip.author.date.startsWith('2024-01-01')).toBe(false);
    });

    it('resets the author identity with resetAuthor', async () => {
      // helpers author commits as author@example.com; repo config user is test@example.com.
      commit(repo.path, 'by someone else', { 'a.txt': 'a\n' });
      await svc.amendCommit({ keepMessage: true, resetAuthor: true });
      const tip = (await svc.log()).find(c => c.hash !== 'UNCOMMITTED')!;
      expect(tip.author.email).toBe('test@example.com');
    });

    it('excludes staged changes when only is set (message/metadata only)', async () => {
      commit(repo.path, 'base', { 'a.txt': 'a\n' });
      writeFileSync(join(repo.path, 'staged.txt'), 's\n');
      runGit(repo.path, ['add', 'staged.txt']);
      await svc.amendCommit({ message: 'reworded', only: true });
      const files = (await svc.showCommitFiles('HEAD')).map(f => f.path);
      expect(files).not.toContain('staged.txt');
      const tip = (await svc.log()).find(c => c.hash !== 'UNCOMMITTED')!;
      expect(tip.subject).toBe('reworded');
    });

    it('rejects an empty message when not keeping the message', async () => {
      commit(repo.path, 'base', { 'a.txt': 'a\n' });
      await expect(svc.amendCommit({ message: '   ' })).rejects.toThrow();
    });
  });

  describe('tag CRUD', () => {
    it('createTag (lightweight) at HEAD', async () => {
      commit(repo.path, 'init');
      await svc.createTag('v1.0');
      const names = (await svc.tags()).map(t => t.name);
      expect(names).toContain('v1.0');
    });

    it('createTag (annotated) with message', async () => {
      commit(repo.path, 'init');
      await svc.createTag('v1.1', undefined, 'first release');
      const t = (await svc.tags()).find(t => t.name === 'v1.1');
      expect(t?.isAnnotated).toBe(true);
      expect(t?.message).toContain('first release');
    });

    it('createTag at a specific commit', async () => {
      const c1 = commit(repo.path, 'first');
      commit(repo.path, 'second');
      await svc.createTag('past', c1);
      const t = (await svc.tags()).find(t => t.name === 'past');
      expect(t).toBeDefined();
      // Tag hash should match c1 (lightweight tags point directly at commits)
      expect(t?.hash).toBe(c1.substring(0, t!.hash.length));
    });

    it('deleteTag removes it', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['tag', 'v0.1']);
      await svc.deleteTag('v0.1');
      const names = (await svc.tags()).map(t => t.name);
      expect(names).not.toContain('v0.1');
    });
  });

  describe('stash lifecycle', () => {
    beforeEach(() => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
    });

    async function dirtyTheTree() {
      writeFileSync(join(repo.path, 'a.txt'), 'two\n');
    }

    it('stashSave + list + drop', async () => {
      await dirtyTheTree();
      await svc.stashSave('wip changes');
      const stashes = await svc.stashList();
      expect(stashes.length).toBe(1);
      expect(stashes[0].message).toContain('wip changes');

      await svc.stashDrop(0);
      expect((await svc.stashList()).length).toBe(0);
    });

    it('stashSave with includeUntracked captures new files', async () => {
      writeFileSync(join(repo.path, 'untracked.txt'), 'fresh\n');
      await svc.stashSave('with untracked', true);
      expect((await svc.stashList()).length).toBe(1);
    });

    it('stashApply restores changes without dropping', async () => {
      await dirtyTheTree();
      await svc.stashSave('keep me');
      // working tree restored to clean state by stash
      expect(await svc.isDirty()).toBe(false);

      await svc.stashApply(0);
      expect(await svc.isDirty()).toBe(true);
      expect((await svc.stashList()).length).toBe(1); // still there
    });

    it('stashPop applies and drops', async () => {
      await dirtyTheTree();
      await svc.stashSave('pop me');
      await svc.stashPop(0);
      expect(await svc.isDirty()).toBe(true);
      expect((await svc.stashList()).length).toBe(0);
    });

    it('stashRename updates the message', async () => {
      await dirtyTheTree();
      await svc.stashSave('old message');
      await svc.stashRename(0, 'renamed message');
      const stashes = await svc.stashList();
      expect(stashes[0].message).toContain('renamed message');
    });

    it('stashRename of a lower (non-top) stash renames the right one without losing others', async () => {
      // Two stashes: stash@{0}=second, stash@{1}=first. Renaming index 1 must
      // hit the older entry and keep the count at 2 (regression guard for the
      // store-prepend index shift).
      await dirtyTheTree();
      await svc.stashSave('first');
      writeFileSync(join(repo.path, 'a.txt'), 'three\n');
      await svc.stashSave('second');

      await svc.stashRename(1, 'first renamed');

      const stashes = await svc.stashList();
      expect(stashes.length).toBe(2);
      expect(stashes.map(s => s.message).join('\n')).toContain('first renamed');
      expect(stashes.map(s => s.message).join('\n')).toContain('second');
      expect(stashes.map(s => s.message).join('\n')).not.toContain('first\n');
    });

    it('stashRename rejects a negative or non-integer index before touching git', async () => {
      await expect(svc.stashRename(-1, 'x')).rejects.toThrow('Invalid stash index');
      await expect(svc.stashRename(1.5, 'x')).rejects.toThrow('Invalid stash index');
    });

    it('stashSave with keepIndex creates a stash but leaves staged changes in place', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      writeFileSync(join(repo.path, 'a.txt'), 'staged change\n');
      runGit(repo.path, ['add', 'a.txt']);
      const before = (await svc.stashList()).length;

      await svc.stashSave('keep', false, true); // keepIndex → --keep-index

      expect((await svc.stashList()).length).toBe(before + 1);
      // --keep-index restores the staged content to the working tree.
      const { staged } = await svc.getUncommittedDiff();
      expect(staged.map(s => s.path)).toContain('a.txt');
    });

    it('stashRestoreFiles restores an untracked stash file instead of deleting it', async () => {
      // Repo shape: `main` has no X.txt; `side` branches off and commits X.txt.
      // Untracked X.txt stashed on main lands in the stash's third parent, so
      // the stash's main tree has no X.txt entry at all.
      commit(repo.path, 'base', { 'base.txt': 'b\n' });
      runGit(repo.path, ['checkout', '-b', 'side']);
      commit(repo.path, 'side commit', { 'X.txt': 'tracked-X\n' });
      runGit(repo.path, ['checkout', 'main']);
      writeFileSync(join(repo.path, 'X.txt'), 'untracked-X-in-stash\n');
      await svc.stashSave('with untracked', true);

      // Move to `side`, where X.txt is a tracked file in the current commit.
      runGit(repo.path, ['checkout', 'side']);
      expect(readFileSync(join(repo.path, 'X.txt'), 'utf8')).toBe('tracked-X\n');

      await svc.stashRestoreFiles(0, ['X.txt']);

      // Restoring from the main stash tree would have deleted X.txt (the
      // stash's main tree lacks it); restoring from the untracked snapshot
      // must bring back the stashed untracked content.
      expect(readFileSync(join(repo.path, 'X.txt'), 'utf8')).toBe('untracked-X-in-stash\n');
    });
  });

  // A stash is internally a merge commit (parent 1 = base, parent 2 = index,
  // parent 3 = untracked snapshot). The diff viewer must show only what the
  // stash actually changed vs its base — not a union against every parent,
  // which falsely flags most of the repo as added/deleted (issue #45).
  describe('stash diff (issue #45)', () => {
    beforeEach(() => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
    });

    async function stashHash(): Promise<string> {
      const stashes = await svc.stashList();
      return stashes[0].hash!;
    }

    it('showCommitFiles on an untracked-only stash lists just the stashed file', async () => {
      writeFileSync(join(repo.path, 'b.txt'), 'b\n');
      await svc.stashSave('untracked only', true); // -u

      const files = await svc.showCommitFiles(await stashHash());
      const paths = files.map(f => f.path);

      expect(paths).toEqual(['b.txt']);
      expect(files[0].status).toBe('A');
    });

    it('showCommitDiff on an untracked-only stash returns just the stashed file', async () => {
      writeFileSync(join(repo.path, 'b.txt'), 'b\n');
      await svc.stashSave('untracked only', true); // -u

      const diffs = await svc.showCommitDiff(await stashHash());

      expect(diffs.map(d => d.file)).toEqual(['b.txt']);
    });

    it('showCommitFiles on a tracked-change stash lists only the modified file', async () => {
      writeFileSync(join(repo.path, 'a.txt'), 'two\n');
      await svc.stashSave('tracked change');

      const files = await svc.showCommitFiles(await stashHash());

      expect(files.map(f => f.path)).toEqual(['a.txt']);
      expect(files[0].status).toBe('M');
    });

    it('showCommitFiles on a mixed stash lists tracked and untracked changes only', async () => {
      writeFileSync(join(repo.path, 'a.txt'), 'two\n'); // tracked modify
      writeFileSync(join(repo.path, 'b.txt'), 'b\n');    // untracked add
      await svc.stashSave('mixed', true); // -u

      const files = await svc.showCommitFiles(await stashHash());
      const byPath = new Map(files.map(f => [f.path, f.status]));

      expect([...byPath.keys()].sort()).toEqual(['a.txt', 'b.txt']);
      expect(byPath.get('a.txt')).toBe('M');
      expect(byPath.get('b.txt')).toBe('A');
    });
  });

  describe('reset', () => {
    it('soft reset keeps working tree, moves HEAD', async () => {
      commit(repo.path, 'first', { 'a.txt': '1\n' });
      const c2 = commit(repo.path, 'second', { 'a.txt': '2\n' });
      const target = commit(repo.path, 'third', { 'a.txt': '3\n' });

      await svc.reset(c2, 'soft');
      // HEAD moved to c2
      expect(head(repo.path)).toBe(c2);
      // But working file still has the "third" content
      expect(existsSync(join(repo.path, 'a.txt'))).toBe(true);
      // And there are staged changes (the third commit's content is now staged)
      const { staged } = await svc.getUncommittedDiff();
      expect(staged.map(s => s.path)).toContain('a.txt');
      void target;
    });

    it('hard reset wipes working tree to target', async () => {
      commit(repo.path, 'first', { 'a.txt': '1\n' });
      const c2 = commit(repo.path, 'second', { 'a.txt': '2\n' });
      commit(repo.path, 'third', { 'a.txt': '3\n' });

      await svc.reset(c2, 'hard');
      expect(head(repo.path)).toBe(c2);
      const { readFileSync } = await import('fs');
      expect(readFileSync(join(repo.path, 'a.txt'), 'utf-8')).toBe('2\n');
    });

    it('mixed reset moves HEAD and unstages, but keeps the working tree', async () => {
      commit(repo.path, 'first', { 'a.txt': '1\n' });
      const c1 = head(repo.path);
      commit(repo.path, 'second', { 'a.txt': '2\n' });

      await svc.reset(c1, 'mixed');
      expect(head(repo.path)).toBe(c1);
      const { readFileSync } = await import('fs');
      // Working tree keeps the "second" content…
      expect(readFileSync(join(repo.path, 'a.txt'), 'utf-8')).toBe('2\n');
      // …but the index was reset, so it shows up as an unstaged change.
      const { unstaged } = await svc.getUncommittedDiff();
      expect(unstaged.map(s => s.path)).toContain('a.txt');
    });
  });

  describe('clean', () => {
    it('removes untracked files', async () => {
      commit(repo.path, 'init');
      writeFileSync(join(repo.path, 'untracked.txt'), 'gone\n');
      await svc.clean(false);
      expect(existsSync(join(repo.path, 'untracked.txt'))).toBe(false);
    });

    it('removes untracked directories with -d', async () => {
      commit(repo.path, 'init');
      const { mkdirSync } = await import('fs');
      mkdirSync(join(repo.path, 'newdir'));
      writeFileSync(join(repo.path, 'newdir', 'f.txt'), 'gone\n');
      await svc.clean(true);
      expect(existsSync(join(repo.path, 'newdir'))).toBe(false);
    });
  });

  describe('stageFile', () => {
    it('moves a file from unstaged to staged', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      writeFileSync(join(repo.path, 'a.txt'), 'two\n');

      // before: a.txt is unstaged
      let result = await svc.getUncommittedDiff();
      expect(result.unstaged.some(s => s.path === 'a.txt')).toBe(true);

      await svc.stageFile('a.txt');

      result = await svc.getUncommittedDiff();
      expect(result.staged.some(s => s.path === 'a.txt')).toBe(true);
    });
  });

  describe('addRemote / removeRemote', () => {
    it('addRemote configures a new remote', async () => {
      commit(repo.path, 'init');
      await svc.addRemote('origin', 'https://example.com/r.git');
      const remotes = await svc.remotes();
      expect(remotes.find(r => r.name === 'origin')).toBeDefined();
    });

    it('removeRemote drops it', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['remote', 'add', 'origin', 'https://example.com/r.git']);
      await svc.removeRemote('origin');
      expect((await svc.remotes()).find(r => r.name === 'origin')).toBeUndefined();
    });
  });

  describe('fastForwardRef (update a non-current branch in place)', () => {
    it('fast-forwards a non-current branch without touching HEAD or the working tree', async () => {
      // topic branches off init, then main advances past it. topic is a strict
      // ancestor of main → the update is a fast-forward.
      const init = commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['branch', 'topic', init]);
      const mainTip = commit(repo.path, 'main second', { 'b.txt': 'b\n' });
      // We stay on main; topic is the non-current branch being advanced.
      expect(currentBranch(repo.path)).toBe('main');
      writeFileSync(join(repo.path, 'dirty.txt'), 'uncommitted\n');

      await svc.fastForwardRef('topic', 'main');

      // topic now points at main's tip…
      expect(runGit(repo.path, ['rev-parse', 'topic']).trim()).toBe(mainTip);
      // …while HEAD stays on main and the working-tree edit is untouched.
      expect(currentBranch(repo.path)).toBe('main');
      expect(head(repo.path)).toBe(mainTip);
      expect(existsSync(join(repo.path, 'dirty.txt'))).toBe(true);
    });

    it('rejects a non-fast-forward update so diverged commits are never clobbered', async () => {
      // init → main adds m1; topic (from init) adds its own t1. The histories
      // diverge, so advancing topic to main is NOT a fast-forward and the
      // `+`-less refspec must make git refuse it.
      const init = commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['branch', 'topic', init]);
      commit(repo.path, 'main m1', { 'm.txt': 'm\n' });
      runGit(repo.path, ['checkout', 'topic']);
      const topicTip = commit(repo.path, 'topic t1', { 't.txt': 't\n' });
      runGit(repo.path, ['checkout', 'main']);

      await expect(svc.fastForwardRef('topic', 'main')).rejects.toThrow();
      // topic is unchanged — its own commit survived.
      expect(runGit(repo.path, ['rev-parse', 'topic']).trim()).toBe(topicTip);
    });
  });
});
