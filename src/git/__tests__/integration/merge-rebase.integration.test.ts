import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, currentBranch, head, runGit, seedBranches, writeFile } from './helpers';

describe('GitService integration — merge / rebase / cherry-pick / revert', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  describe('merge', () => {
    it('fast-forwards when target is ahead of HEAD', async () => {
      const { mainTip, featureTip } = seedBranches(repo.path);
      // main is at mainTip (3rd commit), feature has 2 extra. Reset main to base to allow ff.
      runGit(repo.path, ['reset', '--hard', mainTip]);
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic-only');
      const topicTip = head(repo.path);
      runGit(repo.path, ['checkout', 'main']);

      await svc.merge('topic');
      expect(head(repo.path)).toBe(topicTip);
      void featureTip;
    });

    it('no-ff creates a merge commit even when fast-forward possible', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic-only');
      const topicTip = head(repo.path);
      runGit(repo.path, ['checkout', 'main']);

      await svc.merge('topic', { noFf: true });
      const newHead = head(repo.path);
      expect(newHead).not.toBe(topicTip);
      // Merge commit has 2 parents
      const parents = runGit(repo.path, ['log', '-1', '--format=%P']).trim().split(/\s+/);
      expect(parents.length).toBe(2);
    });

    it('records an in-progress merge state on conflict', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left edit', { 'a.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'right edit', { 'a.txt': 'right\n' });

      await expect(svc.merge('left')).rejects.toThrow();
      const state = await svc.getOperationState();
      expect(state.type).toBe('merge');

      await svc.abortMerge();
      const cleared = await svc.getOperationState();
      expect(cleared.type).toBeNull();
    });

    it('squash merge collapses the branch into a single non-merge commit', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      const mainBase = head(repo.path);
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic 1', { 'b.txt': 'b\n' });
      commit(repo.path, 'topic 2', { 'c.txt': 'c\n' });
      runGit(repo.path, ['checkout', 'main']);

      await svc.merge('topic', { squash: true });
      // squash → a fresh single-parent commit (no merge commit), parented on main.
      const parents = runGit(repo.path, ['log', '-1', '--format=%P']).trim().split(/\s+/).filter(Boolean);
      expect(parents).toEqual([mainBase]);
      // Both topic files landed.
      const files = runGit(repo.path, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
      expect(files).toEqual(expect.arrayContaining(['b.txt', 'c.txt']));
    });

    it('--no-commit merges without creating a commit, leaving a merge in progress', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      const base = head(repo.path);
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic-only', { 'b.txt': 'b\n' });
      runGit(repo.path, ['checkout', 'main']);

      await svc.merge('topic', { noFf: true, noCommit: true });
      // HEAD has not moved and the merge is recorded as in-progress.
      expect(head(repo.path)).toBe(base);
      expect(existsSync(join(repo.path, '.git', 'MERGE_HEAD'))).toBe(true);
      const state = await svc.getOperationState();
      expect(state.type).toBe('merge');
      // The merged content is staged for review, not committed.
      const staged = runGit(repo.path, ['diff', '--cached', '--name-only']).trim().split('\n');
      expect(staged).toContain('b.txt');
    });

    it('--squash --no-commit stages changes without the automatic commit', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      const base = head(repo.path);
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic-only', { 'b.txt': 'b\n' });
      runGit(repo.path, ['checkout', 'main']);

      await svc.merge('topic', { squash: true, noCommit: true });
      // squash already doesn't autocommit; noCommit skips our follow-up commit.
      expect(head(repo.path)).toBe(base);
      const staged = runGit(repo.path, ['diff', '--cached', '--name-only']).trim().split('\n');
      expect(staged).toContain('b.txt');
    });
  });

  describe('rebase', () => {
    it('replays HEAD onto target', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      const baseCommit = head(repo.path);
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic 1', { 't1.txt': '1\n' });
      const topic1 = head(repo.path);
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main 2', { 'm2.txt': '2\n' });
      const mainTip = head(repo.path);

      runGit(repo.path, ['checkout', 'topic']);
      await svc.rebase('main');

      // After rebase: topic's tip parent should be mainTip
      const newParents = runGit(repo.path, ['log', '-1', '--format=%P']).trim().split(/\s+/);
      expect(newParents[0]).toBe(mainTip);
      // Original topic1 commit hash is gone (recomposed)
      expect(head(repo.path)).not.toBe(topic1);
      void baseCommit;
    });

    it('abortRebase restores state on conflict', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edit', { 'a.txt': 'topic\n' });
      const topicTip = head(repo.path);
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      runGit(repo.path, ['checkout', 'topic']);
      await expect(svc.rebase('main')).rejects.toThrow();

      const state = await svc.getOperationState();
      expect(state.type).toBe('rebase');

      await svc.abortRebase();
      // After abort, we're back to topic's original tip
      expect(head(repo.path)).toBe(topicTip);
    });
  });

  describe('cherryPick', () => {
    it('applies a commit from another branch', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      const pickMe = commit(repo.path, 'feature change', { 'feat.txt': 'x\n' });
      runGit(repo.path, ['checkout', 'main']);

      await svc.cherryPick(pickMe);

      const subject = runGit(repo.path, ['log', '-1', '--format=%s']).trim();
      expect(subject).toBe('feature change');
      // The picked file should be present on main now
      expect(readFileSync(join(repo.path, 'feat.txt'), 'utf-8')).toBe('x\n');
    });

    it('applies multiple commits in the given order', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      const c1 = commit(repo.path, 'feat one', { 'f1.txt': '1\n' });
      const c2 = commit(repo.path, 'feat two', { 'f2.txt': '2\n' });
      runGit(repo.path, ['checkout', 'main']);

      await svc.cherryPick([c1, c2]);

      const subjects = runGit(repo.path, ['log', '-2', '--format=%s']).trim().split('\n');
      expect(subjects).toEqual(['feat two', 'feat one']); // newest first in log
      expect(readFileSync(join(repo.path, 'f1.txt'), 'utf-8')).toBe('1\n');
      expect(readFileSync(join(repo.path, 'f2.txt'), 'utf-8')).toBe('2\n');
    });

    it('with noCommit stages changes without committing', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      const pickMe = commit(repo.path, 'feature change', { 'feat.txt': 'x\n' });
      runGit(repo.path, ['checkout', 'main']);

      const beforeTip = head(repo.path);
      await svc.cherryPick(pickMe, { noCommit: true });

      expect(head(repo.path)).toBe(beforeTip); // no new commit
      const { staged } = await svc.getUncommittedDiff();
      expect(staged.some(s => s.path === 'feat.txt')).toBe(true);
    });

    it('leaves a cherry-pick in progress on conflict (detectable + abortable)', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      const conflicting = commit(repo.path, 'feature edit', { 'a.txt': 'feature\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      await expect(svc.cherryPick(conflicting)).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('cherry-pick');

      await svc.abortOperation();
      expect((await svc.getOperationState()).type).toBeNull();
    });
  });

  describe('revert', () => {
    it('creates an inverse commit', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const target = commit(repo.path, 'second', { 'a.txt': 'two\n' });

      await svc.revert(target);

      // After revert, a.txt should be back to "one"
      expect(readFileSync(join(repo.path, 'a.txt'), 'utf-8')).toBe('one\n');
      // And a new commit recorded
      const subject = runGit(repo.path, ['log', '-1', '--format=%s']).trim();
      expect(subject).toMatch(/Revert/i);
    });

    it('with noCommit stages the inverse without committing', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const target = commit(repo.path, 'second', { 'a.txt': 'two\n' });
      const beforeTip = head(repo.path);

      await svc.revert(target, { noCommit: true });

      expect(head(repo.path)).toBe(beforeTip);
      const { staged } = await svc.getUncommittedDiff();
      expect(staged.some(s => s.path === 'a.txt')).toBe(true);
    });

    it('leaves a revert in progress on conflict (detectable + abortable)', async () => {
      // Revert an old commit whose lines have since changed → conflict.
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const target = commit(repo.path, 'second', { 'a.txt': 'two\n' });
      commit(repo.path, 'third', { 'a.txt': 'three\n' });

      await expect(svc.revert(target)).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('revert');

      await svc.abortOperation();
      expect((await svc.getOperationState()).type).toBeNull();
    });
  });

  describe('commitFixup', () => {
    it('commits staged changes as a fixup! of the target commit', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const target = commit(repo.path, 'add feature', { 'feat.txt': 'x\n' });
      commit(repo.path, 'later work', { 'b.txt': 'b\n' });

      // Stage a change to fold into the target later.
      writeFile(repo.path, 'feat.txt', 'x\ny\n');
      runGit(repo.path, ['add', '-A']);

      await svc.commitFixup(target);

      // A new commit is created on top, with the conventional fixup! subject.
      const subject = runGit(repo.path, ['log', '-1', '--format=%s']).trim();
      expect(subject).toBe('fixup! add feature');
    });
  });

  describe('predictConflicts', () => {
    it('reports no conflict for non-overlapping changes', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left adds b', { 'b.txt': 'b\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main adds c', { 'c.txt': 'c\n' });

      const result = await svc.predictConflicts(head(repo.path), 'left');
      expect(result.hasConflict).toBe(false);
      expect(result.files).toEqual([]);
    });

    it('reports conflicting files', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left edit', { 'a.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      const result = await svc.predictConflicts(head(repo.path), 'left');
      expect(result.hasConflict).toBe(true);
      expect(result.files).toContain('a.txt');
    });

    it('reports a conflicting non-ASCII path literally', async () => {
      // merge-tree now runs through exec (core.quotePath=false), so a Korean
      // filename comes back as a literal UTF-8 path, not a dquote-escaped one.
      commit(repo.path, 'init', { '한글.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left edit', { '한글.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { '한글.txt': 'main\n' });

      const result = await svc.predictConflicts(head(repo.path), 'left');
      expect(result.hasConflict).toBe(true);
      expect(result.files).toContain('한글.txt');
    });
  });

  describe('predictRebaseConflicts', () => {
    it('detects conflict when topic edits same file as base advanced', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edit', { 'a.txt': 'topic\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.hasConflict).toBe(true);
    });

    it('reports the correct path for a modify/delete conflict', async () => {
      // main deletes a file the topic modifies → modify/delete conflict. The
      // prose CONFLICT line for this type embeds commit hashes, so the file
      // name must come from the structured file-info section, not the prose.
      commit(repo.path, 'init', { 'doomed.txt': 'base\n', 'keep.txt': 'k\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edits doomed', { 'doomed.txt': 'edited\n' });
      runGit(repo.path, ['checkout', 'main']);
      runGit(repo.path, ['rm', 'doomed.txt']);
      commit(repo.path, 'main deletes doomed');

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.hasConflict).toBe(true);
      expect(result.files).toEqual(['doomed.txt']);
    });

    it('flags truncated when the branch has more than 20 commits to replay', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      for (let i = 0; i < 25; i++) commit(repo.path, `topic ${i}`, { [`t${i}.txt`]: `${i}\n` });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'm.txt': 'm\n' });

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.truncated).toBe(true);
    });

    it('does not flag truncated when 20 or fewer commits replay', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edit', { 'b.txt': 'b\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'm.txt': 'm\n' });

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.truncated).toBeFalsy();
    });

    it('clean rebase reports no conflict', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic adds t', { 't.txt': 't\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main adds m', { 'm.txt': 'm\n' });

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.hasConflict).toBe(false);
    });

    it('returns no-conflict for a fast-forward (no commits to replay)', async () => {
      // When merge-base equals topic, there are zero commits to rebase, so
      // the function should short-circuit to no-conflict instead of running
      // merge-tree on an empty range.
      commit(repo.path, 'init');
      runGit(repo.path, ['branch', 'topic']);
      // main moves forward; topic stays. From topic's POV the rebase is a no-op.
      commit(repo.path, 'main advance');

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.hasConflict).toBe(false);
      expect(result.files).toEqual([]);
    });

    it('falls back to single merge-tree check when histories share no merge base', async () => {
      // Two unrelated histories (no common ancestor): `git merge-base` exits
      // non-zero, so predictRebaseConflicts goes through the early catch
      // block and runs a single mergeTreeCheck instead of walking commits.
      commit(repo.path, 'main only', { 'main.txt': 'm\n' });
      // Create an orphan branch with no shared history.
      runGit(repo.path, ['checkout', '--orphan', 'orphan']);
      runGit(repo.path, ['rm', '-rf', '.']);
      commit(repo.path, 'orphan only', { 'orphan.txt': 'o\n' });
      runGit(repo.path, ['checkout', 'main']);

      // Should resolve without throwing despite the missing merge-base.
      const result = await svc.predictRebaseConflicts('orphan', 'main');
      expect(result).toBeDefined();
      expect(typeof result.hasConflict).toBe('boolean');
    });

    it('stops at the first conflicting commit and reports its files', async () => {
      // Multi-commit topic where the first replayed commit (edits a) already
      // conflicts. A real rebase halts there, so the prediction reports that
      // commit's files rather than walking ahead to b (which the user would
      // only reach after resolving a and running `rebase --continue`).
      commit(repo.path, 'init', { 'a.txt': 'base\n', 'b.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edits a', { 'a.txt': 'topic-a\n' });
      commit(repo.path, 'topic edits b', { 'b.txt': 'topic-b\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edits a', { 'a.txt': 'main-a\n' });
      commit(repo.path, 'main edits b', { 'b.txt': 'main-b\n' });

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.hasConflict).toBe(true);
      expect(result.files).toEqual(['a.txt']);
    });

    it('does not flag a phantom conflict when a later commit edits a file an earlier commit added', async () => {
      // Regression: the topic adds feat.txt then edits it in the next commit,
      // while main advances on an unrelated file. A real rebase is clean
      // because feat.txt exists once the first commit replays. The old logic
      // probed each commit against the original `onto` (which never had
      // feat.txt) and reported a phantom modify/delete conflict.
      commit(repo.path, 'init', { 'base.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic adds feat', { 'feat.txt': 'v1\n' });
      commit(repo.path, 'topic edits feat', { 'feat.txt': 'v2\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main unrelated', { 'main.txt': 'm\n' });

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.hasConflict).toBe(false);
      expect(result.files).toEqual([]);
    });
  });

  describe('getConflictFiles + continueOperation', () => {
    it('lists files with conflict markers during merge', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left', { 'a.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'right', { 'a.txt': 'right\n' });

      await expect(svc.merge('left')).rejects.toThrow();
      const conflicts = await svc.getConflictFiles();
      expect(conflicts).toContain('a.txt');

      // resolve and continue
      const { writeFileSync } = await import('fs');
      writeFileSync(join(repo.path, 'a.txt'), 'merged\n');
      await svc.stageFile('a.txt');
      await svc.continueOperation();

      expect(currentBranch(repo.path)).toBe('main');
      expect((await svc.getOperationState()).type).toBeNull();
    });
  });

  describe('continueOperation — dispatch by operation type', () => {
    it('finalizes a cherry-pick after the conflict is resolved', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      const target = commit(repo.path, 'feature edit', { 'a.txt': 'feature\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      await expect(svc.cherryPick(target)).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('cherry-pick');

      const { writeFileSync } = await import('fs');
      writeFileSync(join(repo.path, 'a.txt'), 'resolved\n');
      await svc.continueOperation();

      expect((await svc.getOperationState()).type).toBeNull();
      expect(readFileSync(join(repo.path, 'a.txt'), 'utf-8')).toBe('resolved\n');
    });

    it('finalizes a revert after the conflict is resolved', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const target = commit(repo.path, 'change', { 'a.txt': 'two\n' });
      commit(repo.path, 'further change', { 'a.txt': 'three\n' });

      await expect(svc.revert(target)).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('revert');

      const { writeFileSync } = await import('fs');
      writeFileSync(join(repo.path, 'a.txt'), 'reverted\n');
      await svc.continueOperation();

      expect((await svc.getOperationState()).type).toBeNull();
      expect(readFileSync(join(repo.path, 'a.txt'), 'utf-8')).toBe('reverted\n');
    });

    it('resumes a rebase after the conflict is resolved (dispatches to rebase --continue)', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edit', { 'a.txt': 'topic\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      runGit(repo.path, ['checkout', 'topic']);
      await expect(svc.rebase('main')).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('rebase');

      const { writeFileSync } = await import('fs');
      writeFileSync(join(repo.path, 'a.txt'), 'resolved\n');
      // Go through the generic dispatcher rather than continueRebase() directly.
      await svc.continueOperation();

      expect((await svc.getOperationState()).type).toBeNull();
    });

    it('commits a squashed merge left in the SQUASH_MSG state', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      commit(repo.path, 'feature work', { 'f.txt': 'f\n' });
      runGit(repo.path, ['checkout', 'main']);

      // Raw `merge --squash` stages the changes and writes SQUASH_MSG without
      // committing — exactly the state the squash branch of continueOperation handles.
      runGit(repo.path, ['merge', '--squash', 'feature']);
      expect((await svc.getOperationState()).type).toBe('squash');

      await svc.continueOperation();

      // The squash commit is finalized: SQUASH_MSG is consumed and f.txt landed
      // as a single non-merge commit on main.
      expect((await svc.getOperationState()).type).toBeNull();
      expect(readFileSync(join(repo.path, 'f.txt'), 'utf-8')).toBe('f\n');
      const parents = runGit(repo.path, ['log', '-1', '--format=%P']).trim().split(/\s+/).filter(Boolean);
      expect(parents.length).toBe(1);
    });
  });

  describe('log() — stash insertion', () => {
    it('inserts stash entries into the commit list near their base commit', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const beforeStash = head(repo.path);
      // Dirty the tree and stash
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'two\n');
      await svc.stashSave('wip-stash-1');

      const commits = await svc.log();
      const stashRow = commits.find(c => c.refs.some(r => r.type === 'stash'));
      expect(stashRow).toBeDefined();
      // Stash's first parent should be the commit it was based on.
      expect(stashRow?.parents).toEqual([beforeStash]);
      // The subject is overridden to the stash message.
      expect(stashRow?.subject).toContain('wip-stash-1');
    });

    it('keeps a stash attached to the tree when its base branch was deleted (#52)', async () => {
      // Shared root on main; feature branches off and adds its own commit.
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      const featureTip = commit(repo.path, 'feature work', { 'f.txt': 'f\n' });
      // Stash on top of feature, then abandon feature so the stash base is no
      // longer reachable from any branch/tag — only the stash ref points at it.
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/f.txt`, 'dirty\n');
      await svc.stashSave('wip-on-feature');
      runGit(repo.path, ['checkout', 'main']);
      runGit(repo.path, ['branch', '-D', 'feature']);

      const commits = await svc.log();
      const hashes = new Set(commits.map(c => c.hash));
      const stashRow = commits.find(c => c.refs.some(r => r.type === 'stash'));
      expect(stashRow).toBeDefined();
      // The stash must connect to the tree: its base commit (first parent) has
      // to be present in the graph, otherwise the badge floats orphaned (#52).
      expect(stashRow?.parents[0]).toBe(featureTip);
      expect(hashes.has(featureTip)).toBe(true);
    });
  });

  describe('interactiveRebase', () => {
    it('reorders commits per the todo list', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'commit A', { 'a.txt': 'A\n' });
      const c2 = commit(repo.path, 'commit B', { 'b.txt': 'B\n' });

      // Reorder: pick B before A
      await svc.interactiveRebase(base, [
        { action: 'pick', hash: c2, subject: 'commit B' },
        { action: 'pick', hash: c1, subject: 'commit A' },
      ]);

      const subjects = runGit(repo.path, ['log', '--format=%s', `${base}..HEAD`])
        .trim().split('\n');
      // git log is reverse-chrono, so newest first
      expect(subjects[0]).toBe('commit A');
      expect(subjects[1]).toBe('commit B');
    });

    it('drops commits marked drop', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'keep me', { 'a.txt': 'A\n' });
      const c2 = commit(repo.path, 'drop me', { 'b.txt': 'B\n' });

      await svc.interactiveRebase(base, [
        { action: 'pick', hash: c1, subject: 'keep me' },
        { action: 'drop', hash: c2, subject: 'drop me' },
      ]);

      const subjects = runGit(repo.path, ['log', '--format=%s', `${base}..HEAD`])
        .trim().split('\n');
      expect(subjects).toEqual(['keep me']);
    });

    it('reword updates the commit message via exec amend', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'old subject', { 'a.txt': 'A\n' });

      await svc.interactiveRebase(base, [
        { action: 'reword', hash: c1, subject: 'old subject', message: 'shiny new subject' },
      ]);

      const subject = runGit(repo.path, ['log', '-1', '--format=%s']).trim();
      expect(subject).toBe('shiny new subject');
    });

    it('reword preserves multi-line commit message via printf pipeline', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'old subject', { 'a.txt': 'A\n' });

      await svc.interactiveRebase(base, [
        { action: 'reword', hash: c1, subject: 'old subject', message: 'new subject\n\nbody line one\nbody line two' },
      ]);

      const fullMsg = runGit(repo.path, ['log', '-1', '--format=%B']).trim();
      expect(fullMsg).toBe('new subject\n\nbody line one\nbody line two');
    });

    it('squash collapses commits and uses the provided final message', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'A', { 'a.txt': 'A\n' });
      const c2 = commit(repo.path, 'B', { 'b.txt': 'B\n' });
      const c3 = commit(repo.path, 'C', { 'c.txt': 'C\n' });

      await svc.interactiveRebase(base, [
        { action: 'pick', hash: c1, subject: 'A', message: 'combined ABC' },
        { action: 'squash', hash: c2, subject: 'B' },
        { action: 'squash', hash: c3, subject: 'C' },
      ]);

      // All three commits should now be one commit with the supplied message.
      const subjects = runGit(repo.path, ['log', '--format=%s', `${base}..HEAD`])
        .trim().split('\n').filter(Boolean);
      expect(subjects.length).toBe(1);
      expect(subjects[0]).toBe('combined ABC');
    });

    it('squash uses multi-line combined message from printf pipeline', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'A', { 'a.txt': 'A\n' });
      const c2 = commit(repo.path, 'B', { 'b.txt': 'B\n' });
      const c3 = commit(repo.path, 'C', { 'c.txt': 'C\n' });

      await svc.interactiveRebase(base, [
        { action: 'pick', hash: c1, subject: 'A', message: 'combined title\n\n- item one\n- item two' },
        { action: 'squash', hash: c2, subject: 'B' },
        { action: 'squash', hash: c3, subject: 'C' },
      ]);

      const fullMsg = runGit(repo.path, ['log', '-1', '--format=%B']).trim();
      expect(fullMsg).toBe('combined title\n\n- item one\n- item two');
    });

    it('fixup discards the squashed commits message (no exec amend)', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'keeper', { 'a.txt': 'A\n' });
      const c2 = commit(repo.path, 'absorbed', { 'b.txt': 'B\n' });

      await svc.interactiveRebase(base, [
        { action: 'pick', hash: c1, subject: 'keeper' },
        { action: 'fixup', hash: c2, subject: 'absorbed' },
      ]);

      const subjects = runGit(repo.path, ['log', '--format=%s', `${base}..HEAD`])
        .trim().split('\n').filter(Boolean);
      expect(subjects.length).toBe(1);
      expect(subjects[0]).toBe('keeper');
    });

    it('rejects when first todo entry is squash', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'A', { 'a.txt': 'A\n' });
      await expect(svc.interactiveRebase(base, [
        { action: 'squash', hash: c1, subject: 'A' },
      ])).rejects.toThrow('cannot be squash or fixup');
    });

    it('rejects invalid hex hash before spawning git', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      await expect(svc.interactiveRebase(base, [
        { action: 'pick', hash: 'not-a-hash', subject: 'x' },
      ])).rejects.toThrow('Invalid commit hash');
    });

    it('pauses on an edit action and leaves a resumable rebase instead of throwing', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'commit A', { 'a.txt': 'A\n' });
      const c2 = commit(repo.path, 'commit B', { 'b.txt': 'B\n' });

      // `edit` makes git stop after applying c1, leaving .git/rebase-merge on
      // disk. interactiveRebase must treat that as a successful pause (resolve),
      // not a rejection, so the UI shows the continue/abort banner.
      await expect(svc.interactiveRebase(base, [
        { action: 'edit', hash: c1, subject: 'commit A' },
        { action: 'pick', hash: c2, subject: 'commit B' },
      ])).resolves.toBeUndefined();

      expect((await svc.getOperationState()).type).toBe('rebase');

      // The rebase can be finished from the paused state.
      await svc.continueRebase();
      expect((await svc.getOperationState()).type).toBeNull();
      const subjects = runGit(repo.path, ['log', '--format=%s', `${base}..HEAD`])
        .trim().split('\n').filter(Boolean);
      expect(subjects).toEqual(['commit B', 'commit A']);
    });

    it('treats a mid-replay conflict as a pause (resolves, leaving an in-progress rebase)', async () => {
      commit(repo.path, 'init', { 'a.txt': '1\n' });
      const base = head(repo.path);
      // Two commits touching the same line. Reordering them so the second is
      // replayed on top of the first makes git stop with a conflict, leaving
      // .git/rebase-merge on disk and a non-zero exit — the "paused" branch.
      const c1 = commit(repo.path, 'set to 2', { 'a.txt': '2\n' });
      const c2 = commit(repo.path, 'set to 3', { 'a.txt': '3\n' });

      await expect(svc.interactiveRebase(base, [
        { action: 'pick', hash: c2, subject: 'set to 3' },
        { action: 'pick', hash: c1, subject: 'set to 2' },
      ])).resolves.toBeUndefined();

      expect((await svc.getOperationState()).type).toBe('rebase');
      expect(await svc.getConflictFiles()).toContain('a.txt');

      // Abort to leave the temp repo in a clean state.
      await svc.abortOperation();
      expect((await svc.getOperationState()).type).toBeNull();
    });
  });

  describe('getRebaseCommits', () => {
    it('lists commits that would be rebased onto base', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      commit(repo.path, 'a', { 'a.txt': 'a\n' });
      commit(repo.path, 'b', { 'b.txt': 'b\n' });

      const commits = await svc.getRebaseCommits(base);
      // Two commits between base and HEAD
      expect(commits.length).toBe(2);
      const subjects = commits.map(c => c.subject);
      expect(subjects).toContain('a');
      expect(subjects).toContain('b');
    });

    it('returns empty when HEAD is at base', async () => {
      commit(repo.path, 'only');
      const commits = await svc.getRebaseCommits(head(repo.path));
      expect(commits).toEqual([]);
    });
  });

  describe('rebase state machine — continueRebase / skipRebase', () => {
    it('continueRebase resumes after resolving conflict', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edit', { 'a.txt': 'topic\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      runGit(repo.path, ['checkout', 'topic']);
      await expect(svc.rebase('main')).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('rebase');

      // Resolve and continue
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'resolved\n');
      await svc.stageFile('a.txt');
      await svc.continueRebase();

      expect((await svc.getOperationState()).type).toBeNull();
    });

    it('skipRebase drops the offending commit and finishes', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edit', { 'a.txt': 'topic\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      runGit(repo.path, ['checkout', 'topic']);
      await expect(svc.rebase('main')).rejects.toThrow();

      await svc.skipRebase();
      expect((await svc.getOperationState()).type).toBeNull();
    });
  });

  describe('drag-to-rebase-merge sequences', () => {
    it('drag-rebase: checkout source then rebase onto target replays source on top of target', async () => {
      // Set up diverging branches: main and feature both start from a common base commit.
      commit(repo.path, 'base', { 'base.txt': 'base\n' });
      const baseCommit = head(repo.path);
      runGit(repo.path, ['checkout', '-b', 'feature']);
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'on main', { 'main.txt': 'main\n' });
      const mainTip = head(repo.path);
      runGit(repo.path, ['checkout', 'feature']);
      commit(repo.path, 'on feature', { 'feature.txt': 'feature\n' });

      // Operation under test: rebase feature onto main (simulating drag-rebase).
      // We are already on feature (the source branch).
      await svc.rebase('main');

      // Assert: feature is still current after rebase.
      expect(currentBranch(repo.path)).toBe('feature');

      // Assert: feature's tip parent is mainTip (the source commit was replayed on top of main).
      const newParent = runGit(repo.path, ['log', '-1', '--format=%P']).trim();
      expect(newParent).toBe(mainTip);

      // Assert: "on feature" subject is the HEAD commit; "on main" appears earlier.
      const subjects = runGit(repo.path, ['log', '--format=%s']).trim().split('\n');
      expect(subjects[0]).toBe('on feature');
      expect(subjects).toContain('on main');

      void baseCommit;
    });

    it('drag-merge: checkout target then merge --no-ff creates a merge commit on target', async () => {
      // Set up: feature diverges from main.
      commit(repo.path, 'base', { 'base.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      commit(repo.path, 'on feature', { 'feature.txt': 'feature\n' });
      runGit(repo.path, ['checkout', 'main']);

      // Operation under test: merge feature into main with --no-ff (simulating drag-merge).
      // We are on main (the target branch).
      await svc.merge('feature', { noFf: true });

      // Assert: main is still current after merge.
      expect(currentBranch(repo.path)).toBe('main');

      // Assert: HEAD is a merge commit (has 2 parents).
      const parents = runGit(repo.path, ['log', '-1', '--format=%P']).trim().split(/\s+/).filter(Boolean);
      expect(parents.length).toBe(2);

      // Assert: "on feature" subject appears in the merged log.
      const subjects = runGit(repo.path, ['log', '--format=%s']).trim().split('\n');
      expect(subjects).toContain('on feature');
    });
  });

  describe('abortOperation (generic)', () => {
    it('aborts a merge in progress', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left', { 'a.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'right', { 'a.txt': 'right\n' });

      await expect(svc.merge('left')).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('merge');

      await svc.abortOperation();
      expect((await svc.getOperationState()).type).toBeNull();
    });

    it('aborts a rebase in progress', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic', { 'a.txt': 'topic\n' });
      const topicTip = head(repo.path);
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main', { 'a.txt': 'main\n' });

      runGit(repo.path, ['checkout', 'topic']);
      await expect(svc.rebase('main')).rejects.toThrow();
      await svc.abortOperation();
      expect((await svc.getOperationState()).type).toBeNull();
      expect(head(repo.path)).toBe(topicTip);
    });

    it('resets a squashed merge left in the SQUASH_MSG state', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      const mainTip = head(repo.path);
      runGit(repo.path, ['checkout', '-b', 'feature']);
      commit(repo.path, 'feature work', { 'f.txt': 'f\n' });
      runGit(repo.path, ['checkout', 'main']);

      // Stage a squash merge but do not commit it.
      runGit(repo.path, ['merge', '--squash', 'feature']);
      expect((await svc.getOperationState()).type).toBe('squash');

      // abortOperation runs `reset --hard HEAD`, discarding the staged squash
      // changes and leaving HEAD untouched.
      await svc.abortOperation();
      expect(head(repo.path)).toBe(mainTip);
      expect(existsSync(join(repo.path, 'f.txt'))).toBe(false);
    });
  });
});
