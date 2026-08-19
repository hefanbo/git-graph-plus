import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit } from './helpers';

describe('GitService integration — shallow clones', () => {
  let src: TempRepo;
  let shallowPath: string;
  let svc: GitService;

  beforeEach(() => {
    // A local-path clone ignores --depth; use a file:// URL so the clone is a
    // genuine shallow clone with a `grafted` boundary commit.
    src = createTempRepo();
    for (let i = 1; i <= 5; i++) commit(src.path, `commit ${i}`, { 'f.txt': `${i}\n` });
    shallowPath = mkdtempSync(join(tmpdir(), 'ggp-shallow-'));
    runGit(shallowPath, ['clone', '--depth', '2', `file://${src.path}`, 'shallow']);
    svc = new GitService(join(shallowPath, 'shallow'));
  });
  afterEach(() => {
    rmSync(shallowPath, { recursive: true, force: true });
    src.cleanup();
  });

  it('does not invent a "grafted" branch at the shallow boundary', async () => {
    const shallow = join(shallowPath, 'shallow');
    const headHash = runGit(shallow, ['rev-parse', 'HEAD']).trim();
    const boundary = runGit(shallow, ['rev-parse', 'HEAD~1']).trim();
    // Guard that the clone really is shallow (a local-path clone silently
    // ignores --depth, which would make this a non-test).
    expect(readFileSync(join(shallowPath, 'shallow/.git/shallow'), 'utf8').split('\n')).toContain(boundary);

    const commits = await svc.log();
    expect(commits.length).toBeGreaterThan(0);
    // No commit may be labeled with a fake "grafted" branch (this is exactly
    // the bug that `git log --format=%D` parsing used to produce).
    for (const c of commits) {
      expect(c.refs.some(r => r.name === 'grafted')).toBe(false);
    }

    // HEAD is annotated as the checked-out branch, with its remote refs.
    const headRow = commits.find(c => c.hash === headHash);
    expect(headRow?.refs.some(r => r.type === 'head' && r.name === 'main')).toBe(true);
    expect(headRow?.refs.some(r => r.type === 'remote-branch' && r.remote === 'origin' && r.name === 'main')).toBe(true);

    // The boundary commit has no refs at all — it is the truncated edge of
    // history, not a branch tip — but it IS flagged as grafted so the graph
    // can draw the inverted-triangle dot.
    const boundaryRow = commits.find(c => c.hash === boundary);
    expect(boundaryRow).toBeDefined();
    expect(boundaryRow!.refs).toEqual([]);
    expect(boundaryRow!.grafted).toBe(true);
  });

  it('resolves a genuinely-named "grafted" branch via its real ref', async () => {
    const shallow = join(shallowPath, 'shallow');
    const boundary = runGit(shallow, ['rev-parse', 'HEAD~1']).trim();
    // A real branch literally named "grafted" pointing at the boundary commit.
    runGit(shallow, ['update-ref', 'refs/heads/grafted', boundary]);

    const commits = await svc.log();
    const boundaryRow = commits.find(c => c.hash === boundary);
    expect(boundaryRow?.refs.some(r => r.type === 'branch' && r.name === 'grafted')).toBe(true);
  });
});
