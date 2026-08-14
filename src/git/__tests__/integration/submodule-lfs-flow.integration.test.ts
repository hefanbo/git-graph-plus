import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit } from './helpers';

/**
 * Tools-dependent integrations: we run tests when the underlying CLI is
 * available, otherwise skip rather than fail — both git-lfs and git-flow
 * are optional system dependencies that ship the extension's features but
 * shouldn't gate the test suite on a developer's local install.
 */
function isInstalled(cmd: string, args: string[]): boolean {
  try {
    execSync(`${cmd} ${args.join(' ')}`, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

const hasLfs = isInstalled('git', ['lfs', 'version']);
const hasFlow = isInstalled('git', ['flow', 'version']);

describe('GitService integration — submodule', () => {
  let parent: TempRepo;
  let library: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    parent = createTempRepo();
    library = createTempRepo();
    svc = new GitService(parent.path);

    commit(library.path, 'lib v1', { 'lib.txt': 'v1\n' });
    commit(parent.path, 'init', { 'README.md': 'r\n' });
    // protocol.file.allow=always required since CVE-2022-39253.
    runGit(parent.path, [
      '-c', 'protocol.file.allow=always',
      'submodule', 'add', `file://${library.path}`, 'libs/lib',
    ]);
    runGit(parent.path, ['commit', '-m', 'add submodule']);
  });
  afterEach(() => {
    parent.cleanup();
    library.cleanup();
  });

  it('submoduleStatus lists registered submodules with hash and path', async () => {
    // Debug the raw output so test failures show us what's happening on
    // different git versions.
    const raw = runGit(parent.path, ['submodule', 'status']);
    const subs = await svc.submoduleStatus();
    expect(subs.length, `raw output: ${JSON.stringify(raw)}`).toBeGreaterThanOrEqual(1);
    const lib = subs.find(s => s.path === 'libs/lib');
    expect(lib).toBeDefined();
    expect(lib?.hash).toMatch(/^[0-9a-f]+$/);
    // Fresh `submodule add` may leave the entry in `clean` state OR the
    // gitlink may not have been refreshed yet; both are acceptable here as
    // long as it's not 'uninitialized' (the entry exists in the working tree).
    expect(['clean', 'modified', 'conflict']).toContain(lib?.status);
  });

  it('submoduleStatus reports modified state when submodule HEAD drifts', async () => {
    const libDir = join(parent.path, 'libs', 'lib');
    // Move the submodule's checked-out commit so it differs from what the
    // parent's gitlink records → status flips to 'modified'.
    runGit(libDir, ['commit', '--allow-empty', '-m', 'drift']);

    const subs = await svc.submoduleStatus();
    const lib = subs.find(s => s.path === 'libs/lib');
    expect(lib?.status).toBe('modified');
  });

  it('submoduleStatus returns [] when no submodules', async () => {
    const standalone = createTempRepo();
    try {
      commit(standalone.path, 'init');
      const standaloneSvc = new GitService(standalone.path);
      expect(await standaloneSvc.submoduleStatus()).toEqual([]);
    } finally {
      standalone.cleanup();
    }
  });

  it('submoduleUpdate({ init: true }) initialises and checks out submodules', async () => {
    // Simulate a fresh clone: deinit the submodule so its working tree is
    // empty, then ask GitService to init+update it back.
    runGit(parent.path, ['submodule', 'deinit', '-f', 'libs/lib']);
    // Sanity: the working dir of the submodule is now empty.
    const { readdirSync } = await import('fs');
    expect(readdirSync(join(parent.path, 'libs', 'lib')).length).toBe(0);

    await svc.submoduleUpdate(true);

    // After update --init, the submodule is checked out again.
    expect(readdirSync(join(parent.path, 'libs', 'lib')).length).toBeGreaterThan(0);
  });

  // Regression: in a submodule `.git` is a file pointing at the real gitdir,
  // not a directory. Writing the rebase-todo into `<repo>/.git/...` or probing
  // `<repo>/.git/rebase-merge` failed with ENOTDIR / missed the paused state.
  describe('interactiveRebase', () => {
    let subPath: string;
    let subSvc: GitService;

    beforeEach(() => {
      subPath = join(parent.path, 'libs', 'lib');
      subSvc = new GitService(subPath);
      // The submodule *clone* inherits no identity, and GitService spawns git
      // with the ambient environment — so a rebase that re-creates commits
      // would fail with "Committer identity unknown" on a machine without a
      // global git identity (e.g. CI). Configure it locally like createTempRepo.
      runGit(subPath, ['config', 'user.name', 'Test User']);
      runGit(subPath, ['config', 'user.email', 'test@example.com']);
      runGit(subPath, ['config', 'commit.gpgsign', 'false']);
    });

    it('reorders commits in a submodule working tree', async () => {
      const base = runGit(subPath, ['rev-parse', 'HEAD']).trim();
      const c1 = commit(subPath, 'sub A', { 'a.txt': 'A\n' });
      const c2 = commit(subPath, 'sub B', { 'b.txt': 'B\n' });

      await subSvc.interactiveRebase(base, [
        { action: 'pick', hash: c2, subject: 'sub B' },
        { action: 'pick', hash: c1, subject: 'sub A' },
      ]);

      const subjects = runGit(subPath, ['log', '--format=%s', `${base}..HEAD`])
        .trim().split('\n');
      // git log is reverse-chrono, so newest first.
      expect(subjects[0]).toBe('sub A');
      expect(subjects[1]).toBe('sub B');
    });

    it('detects the paused rebase state when a submodule replay conflicts', async () => {
      const base = runGit(subPath, ['rev-parse', 'HEAD']).trim();
      // Two commits touching the same line; reordering them makes git stop with
      // a conflict, leaving rebase-merge in the submodule's real gitdir.
      writeFileSync(join(subPath, 'conflict.txt'), '1\n');
      const c1 = commit(subPath, 'set to 2', { 'conflict.txt': '2\n' });
      const c2 = commit(subPath, 'set to 3', { 'conflict.txt': '3\n' });

      await expect(subSvc.interactiveRebase(base, [
        { action: 'pick', hash: c2, subject: 'set to 3' },
        { action: 'pick', hash: c1, subject: 'set to 2' },
      ])).resolves.toBeUndefined();

      expect((await subSvc.getOperationState()).type).toBe('rebase');

      await subSvc.abortOperation();
      expect((await subSvc.getOperationState()).type).toBeNull();
    });
  });
});

// LFS catch-path checks run regardless of whether git-lfs is installed —
// in a plain repo with no LFS tracking, both calls should resolve to [].
describe('GitService integration — LFS in a non-LFS repo', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'init', { 'a.txt': 'a\n' });
  });
  afterEach(() => repo.cleanup());

  it('lfsLsFiles returns [] (no .gitattributes / no LFS)', async () => {
    // If git-lfs is installed, this exits 0 with empty output; if not, the
    // catch fallback returns []. Either way: [].
    expect(await svc.lfsLsFiles()).toEqual([]);
  });

  it('lfsLocks reports none or unknown without a server / without LFS', async () => {
    const result = await svc.lfsLocks();
    expect(['none', 'unknown']).toContain(result.status);
  });
});

describe.skipIf(!hasLfs)('GitService integration — Git LFS', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    runGit(repo.path, ['lfs', 'install', '--local']);
    runGit(repo.path, ['lfs', 'track', '*.bin']);
    runGit(repo.path, ['add', '.gitattributes']);
    runGit(repo.path, ['commit', '-m', 'track lfs']);
    writeFileSync(join(repo.path, 'data.bin'), Buffer.from([0, 1, 2, 3, 4, 5]));
    runGit(repo.path, ['add', 'data.bin']);
    runGit(repo.path, ['commit', '-m', 'add binary']);
  });
  afterEach(() => repo.cleanup());

  it('lfsLsFiles returns tracked LFS files with oid', async () => {
    const files = await svc.lfsLsFiles();
    const bin = files.find(f => f.path === 'data.bin');
    expect(bin).toBeDefined();
    expect(bin?.oid).toMatch(/^[0-9a-f]+$/);
  });

  it('lfsLocks reports none when no locks set (server-less mode)', async () => {
    // Without a remote LFS server, `lfs locks` returns empty or errors out;
    // either way our wrapper resolves to a non-ok status (none or unknown).
    const result = await svc.lfsLocks();
    expect(['none', 'unknown']).toContain(result.status);
  });
});

describe.skipIf(!hasFlow)('GitService integration — Git Flow', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    // Need at least one commit on `main` (the production branch) so
    // `flow init` has something to base develop on.
    commit(repo.path, 'init', { 'README.md': 'r\n' });
  });
  afterEach(() => repo.cleanup());

  it('isFlowInstalled reports true when git-flow is on PATH', async () => {
    expect(await svc.isFlowInstalled()).toBe(true);
  });

  it('isFlowInitialized is false on a fresh repo', async () => {
    expect(await svc.isFlowInitialized()).toBe(false);
  });

  it('flowInit configures branches + prefixes + tag prefix', async () => {
    await svc.flowInit({
      productionBranch: 'main',
      developBranch: 'develop',
      featurePrefix: 'feature/',
      releasePrefix: 'release/',
      hotfixPrefix: 'hotfix/',
      versionTagPrefix: 'v',
    });
    expect(await svc.isFlowInitialized()).toBe(true);

    const cfg = await svc.getFlowConfig();
    expect(cfg).toMatchObject({
      productionBranch: 'main',
      developBranch: 'develop',
      featurePrefix: 'feature/',
      releasePrefix: 'release/',
      hotfixPrefix: 'hotfix/',
      versionTagPrefix: 'v',
    });
  });

  it('flowInit fails clearly when production branch is missing', async () => {
    const empty = createTempRepo();
    try {
      const emptySvc = new GitService(empty.path);
      // No commits yet → `main` doesn't exist.
      await expect(emptySvc.flowInit({
        productionBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        versionTagPrefix: 'v',
      })).rejects.toThrow(/does not exist/);
    } finally {
      empty.cleanup();
    }
  });

  it('flowFeatureStart creates a feature branch with the configured prefix', async () => {
    await svc.flowInit({
      productionBranch: 'main',
      developBranch: 'develop',
      featurePrefix: 'feature/',
      releasePrefix: 'release/',
      hotfixPrefix: 'hotfix/',
      versionTagPrefix: 'v',
    });
    await svc.flowFeatureStart('login');

    const branches = await svc.getFlowBranches();
    expect(branches.features).toContain('feature/login');
  });

  it('getFlowConfig returns null when not initialised', async () => {
    expect(await svc.getFlowConfig()).toBeNull();
  });

  describe('flow lifecycle (after init)', () => {
    beforeEach(async () => {
      await svc.flowInit({
        productionBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
        versionTagPrefix: 'v',
      });
    });

    it('flowFeatureFinish merges the feature into develop and deletes the branch', async () => {
      await svc.flowFeatureStart('login');
      // Make at least one commit so the merge has content (git-flow tolerates
      // empty merges, but a real commit exercises the merge path properly).
      commit(repo.path, 'feature work', { 'login.ts': 'x\n' });

      await svc.flowFeatureFinish('login');

      const branches = await svc.getFlowBranches();
      expect(branches.features).not.toContain('feature/login');
      // Develop should now contain the feature work.
      runGit(repo.path, ['checkout', 'develop']);
      const log = runGit(repo.path, ['log', '--format=%s', '-n', '5']);
      expect(log).toContain('feature work');
    });

    it('flowReleaseStart + flowReleaseFinish tags the version and merges back', async () => {
      // Need a develop commit so release start has something to base off of.
      runGit(repo.path, ['checkout', 'develop']);
      commit(repo.path, 'pre-release work', { 'feat.ts': 'x\n' });

      await svc.flowReleaseStart('1.0.0');
      const branches1 = await svc.getFlowBranches();
      expect(branches1.releases).toContain('release/1.0.0');

      await svc.flowReleaseFinish('1.0.0');
      // After finish, release branch should be gone and tag should exist.
      const branchesAfter = await svc.getFlowBranches();
      expect(branchesAfter.releases).not.toContain('release/1.0.0');
      const tags = runGit(repo.path, ['tag', '-l']);
      expect(tags).toContain('v1.0.0');
    });

    it('flowHotfixStart + flowHotfixFinish tags from main and merges back', async () => {
      await svc.flowHotfixStart('1.0.1');
      const branches1 = await svc.getFlowBranches();
      expect(branches1.hotfixes).toContain('hotfix/1.0.1');

      // git-flow requires at least one commit on the hotfix branch before finish.
      commit(repo.path, 'hotfix patch', { 'patch.ts': 'p\n' });

      await svc.flowHotfixFinish('1.0.1');
      const branchesAfter = await svc.getFlowBranches();
      expect(branchesAfter.hotfixes).not.toContain('hotfix/1.0.1');
      const tags = runGit(repo.path, ['tag', '-l']);
      expect(tags).toContain('v1.0.1');
    });
  });
});
