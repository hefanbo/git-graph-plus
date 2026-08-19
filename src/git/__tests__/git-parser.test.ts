import { describe, it, expect } from 'vitest';
import { parseLog, parseShowRef, annotateCommitsWithRefs, parseBranches, parseTags, parseRemotes, parseStashList, parseDiff, parseWorktreeList, parseLfsFiles, parseLfsLocks, splitUpstreamRef, mapSignatureStatus } from '../git-parser';
import type { Commit } from '../types';


describe('parseLog', () => {
  it('should return empty array for empty input', () => {
    expect(parseLog('')).toEqual([]);
    expect(parseLog('   ')).toEqual([]);
  });

  it('should parse a single commit', () => {
    const raw = '\x01\x02\x03abc123def456\x00abc123d\x00Alice\x00alice@example.com\x002024-01-15T10:30:00+09:00\x00Alice\x00alice@example.com\x002024-01-15T10:30:00+09:00\x00Initial commit\x00\x00';
    const result = parseLog(raw);

    expect(result).toHaveLength(1);
    expect(result[0].hash).toBe('abc123def456');
    expect(result[0].abbreviatedHash).toBe('abc123d');
    expect(result[0].author.name).toBe('Alice');
    expect(result[0].author.email).toBe('alice@example.com');
    expect(result[0].subject).toBe('Initial commit');
    expect(result[0].parents).toEqual([]);
  });

  it('should parse multiple commits', () => {
    const raw =
      '\x01\x02\x03aaa111\x00aaa\x00Alice\x00a@x.com\x002024-01-02\x00Alice\x00a@x.com\x002024-01-02\x00Second commit\x00bbb222\x00' +
      '\x01\x02\x03bbb222\x00bbb\x00Bob\x00b@x.com\x002024-01-01\x00Bob\x00b@x.com\x002024-01-01\x00First commit\x00\x00';
    const result = parseLog(raw);

    expect(result).toHaveLength(2);
    expect(result[0].hash).toBe('aaa111');
    expect(result[0].parents).toEqual(['bbb222']);
    expect(result[1].hash).toBe('bbb222');
    expect(result[1].parents).toEqual([]);
  });

  it('should parse merge commit with multiple parents', () => {
    const raw = '\x01\x02\x03merge1\x00mer\x00Alice\x00a@x.com\x002024-01-03\x00Alice\x00a@x.com\x002024-01-03\x00Merge branch\x00parent1 parent2\x00';
    const result = parseLog(raw);

    expect(result).toHaveLength(1);
    expect(result[0].parents).toEqual(['parent1', 'parent2']);
  });

  it('should leave signatureStatus undefined when the signature column is absent', () => {
    const raw = '\x01\x02\x03abc123\x00abc\x00Alice\x00a@x.com\x002024-01-01\x00Alice\x00a@x.com\x002024-01-01\x00Commit\x00\x00body text';
    const result = parseLog(raw);
    expect(result[0].signatureStatus).toBeUndefined();
  });

  it('should parse signatureStatus from the appended %G? column', () => {
    // ...subject\x00parents\x00body\x00<code>
    const make = (code: string) =>
      `\x01\x02\x03abc123\x00abc\x00Alice\x00a@x.com\x002024-01-01\x00Alice\x00a@x.com\x002024-01-01\x00Commit\x00\x00\x00${code}`;
    expect(parseLog(make('G'))[0].signatureStatus).toBe('good');
    expect(parseLog(make('N'))[0].signatureStatus).toBe('none');
    expect(parseLog(make('U'))[0].signatureStatus).toBe('unverified');
    expect(parseLog(make('B'))[0].signatureStatus).toBe('unverified');
  });

  it('should still parse signatureStatus when the body is non-empty', () => {
    const raw = '\x01\x02\x03abc123\x00abc\x00Alice\x00a@x.com\x002024-01-01\x00Alice\x00a@x.com\x002024-01-01\x00Commit\x00\x00multi\nline body\x00G';
    const result = parseLog(raw);
    expect(result[0].body).toBe('multi\nline body');
    expect(result[0].signatureStatus).toBe('good');
  });
});

describe('mapSignatureStatus', () => {
  it('maps G to good and N to none', () => {
    expect(mapSignatureStatus('G')).toBe('good');
    expect(mapSignatureStatus('N')).toBe('none');
  });

  it('maps every other verification code to unverified', () => {
    for (const code of ['B', 'U', 'X', 'Y', 'R', 'E']) {
      expect(mapSignatureStatus(code)).toBe('unverified');
    }
  });

  it('trims whitespace (the column may carry a trailing newline)', () => {
    expect(mapSignatureStatus('G\n')).toBe('good');
    expect(mapSignatureStatus(' N ')).toBe('none');
  });

  it('returns undefined for an empty code', () => {
    expect(mapSignatureStatus('')).toBeUndefined();
    expect(mapSignatureStatus('   ')).toBeUndefined();
  });
});

describe('parseShowRef', () => {
  it('should return empty data for empty input', () => {
    expect(parseShowRef('')).toEqual({ head: null, heads: [], tags: [], remotes: [] });
    expect(parseShowRef('   ')).toEqual({ head: null, heads: [], tags: [], remotes: [] });
  });

  it('should parse HEAD, heads, tags and remotes', () => {
    const raw = [
      '1111111 HEAD',
      '1111111 refs/heads/main',
      '2222222 refs/heads/feature/login',
      '3333333 refs/tags/v1.0',
      '4444444 refs/tags/v2.0',
      '5555555 refs/tags/v2.0^{}',
      '1111111 refs/remotes/origin/main',
      '1111111 refs/remotes/origin/HEAD',
    ].join('\n');
    expect(parseShowRef(raw)).toEqual({
      head: '1111111',
      heads: [
        { hash: '1111111', name: 'main' },
        { hash: '2222222', name: 'feature/login' },
      ],
      tags: [
        { hash: '3333333', name: 'v1.0' },
        { hash: '5555555', name: 'v2.0' },
      ],
      remotes: [
        { hash: '1111111', name: 'origin/main' },
        { hash: '1111111', name: 'origin/HEAD' },
      ],
    });
  });

  it('uses the peeled hash for annotated tags and ignores non-ref lines', () => {
    // Annotated tag v2.0: the tag-object hash (4444444) is replaced by the
    // peeled commit hash (5555555). Unknown refs (refs/notes, refs/stash) are
    // skipped.
    const raw = [
      '4444444 refs/tags/v2.0',
      '5555555 refs/tags/v2.0^{}',
      '7777777 refs/notes/commits',
      '8888888 refs/stash',
      'malformed line without hash',
    ].join('\n');
    expect(parseShowRef(raw).tags).toEqual([{ hash: '5555555', name: 'v2.0' }]);
  });
});

describe('annotateCommitsWithRefs', () => {
  const makeCommit = (hash: string, refs: Commit['refs'] = []): Commit => ({
    hash,
    abbreviatedHash: hash.slice(0, 7),
    author: { name: '', email: '', date: '' },
    committer: { name: '', email: '', date: '' },
    subject: '',
    body: '',
    parents: [],
    refs,
  });

  it('marks the checked-out branch as head, not branch (mirrors "HEAD -> main")', () => {
    const commits = [makeCommit('1111111'), makeCommit('2222222')];
    annotateCommitsWithRefs(commits, {
      head: '1111111',
      heads: [
        { hash: '1111111', name: 'main' },
        { hash: '2222222', name: 'feature' },
      ],
      tags: [],
      remotes: [],
    }, 'main');

    expect(commits[0].refs).toEqual([{ type: 'head', name: 'main' }]);
    expect(commits[1].refs).toEqual([{ type: 'branch', name: 'feature' }]);
  });

  it('annotates detached HEAD with a head ref named HEAD', () => {
    const commits = [makeCommit('1111111'), makeCommit('2222222')];
    annotateCommitsWithRefs(commits, {
      head: '2222222',
      heads: [{ hash: '1111111', name: 'main' }],
      tags: [],
      remotes: [],
    }, 'HEAD');

    expect(commits[0].refs).toEqual([{ type: 'branch', name: 'main' }]);
    expect(commits[1].refs).toEqual([{ type: 'head', name: 'HEAD' }]);
  });

  it('attaches tags and remote branches, splitting the remote from the name', () => {
    const commits = [makeCommit('1111111')];
    annotateCommitsWithRefs(commits, {
      head: null,
      heads: [],
      tags: [{ hash: '1111111', name: 'v1.0' }],
      remotes: [
        { hash: '1111111', name: 'origin/main' },
        { hash: '1111111', name: 'origin/feature/login' },
        { hash: '1111111', name: 'origin/HEAD' },
      ],
    }, 'main');

    expect(commits[0].refs).toEqual([
      { type: 'tag', name: 'v1.0' },
      { type: 'remote-branch', name: 'main', remote: 'origin' },
      { type: 'remote-branch', name: 'feature/login', remote: 'origin' },
      { type: 'remote-branch', name: 'HEAD', remote: 'origin' },
    ]);
  });

  it('ignores refs whose commit is not in the list', () => {
    const commits = [makeCommit('1111111')];
    annotateCommitsWithRefs(commits, {
      head: '9999999',
      heads: [
        { hash: '1111111', name: 'main' },
        { hash: '9999999', name: 'elsewhere' },
      ],
      tags: [{ hash: '9999999', name: 'v1.0' }],
      remotes: [{ hash: '9999999', name: 'origin/elsewhere' }],
    }, 'main');

    expect(commits[0].refs).toEqual([{ type: 'head', name: 'main' }]);
  });

  it('appends to existing refs instead of replacing them (stash badge)', () => {
    const commits = [makeCommit('1111111', [{ type: 'stash', name: 'stash@{0}' }])];
    annotateCommitsWithRefs(commits, {
      head: '1111111',
      heads: [{ hash: '1111111', name: 'main' }],
      tags: [],
      remotes: [],
    }, 'main');

    expect(commits[0].refs).toEqual([
      { type: 'stash', name: 'stash@{0}' },
      { type: 'head', name: 'main' },
    ]);
  });

  it('does not invent a grafted ref: only real refs from show-ref are attached', () => {
    // Regression for shallow clones: git's `%D` decoration would contain a
    // synthetic `grafted` token on the boundary commit, which was misparsed as
    // a branch. show-ref data has no such token — the boundary commit simply
    // gets no refs unless a real ref points at it.
    const commits = [makeCommit('1111111')];
    annotateCommitsWithRefs(commits, { head: '1111111', heads: [], tags: [], remotes: [] }, 'HEAD');
    expect(commits[0].refs).toEqual([{ type: 'head', name: 'HEAD' }]);

    // ...but a genuinely-named `grafted` branch is still resolved via its hash.
    const withGraftedBranch = [makeCommit('2222222')];
    annotateCommitsWithRefs(withGraftedBranch, {
      head: null,
      heads: [{ hash: '2222222', name: 'grafted' }],
      tags: [],
      remotes: [],
    }, 'main');
    expect(withGraftedBranch[0].refs).toEqual([{ type: 'branch', name: 'grafted' }]);
  });
});

describe('parseBranches', () => {
  it('should return empty array for empty input', () => {
    expect(parseBranches('')).toEqual([]);
  });

  it('should parse current branch', () => {
    const raw = '*main\x00abc1234\x00origin/main\x00ahead 2, behind 1';
    const result = parseBranches(raw);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('main');
    expect(result[0].current).toBe(true);
    expect(result[0].hash).toBe('abc1234');
    expect(result[0].upstream).toBe('origin/main');
    expect(result[0].ahead).toBe(2);
    expect(result[0].behind).toBe(1);
  });

  it('should strip heads/ prefix from local branch names', () => {
    const raw = ' heads/test\x00abc1234\x00\x00\x00refs/heads/heads/test';
    const result = parseBranches(raw);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('test');
  });

  it('should not strip heads/ from remote branch names', () => {
    const raw = ' origin/heads/test\x00abc1234\x00\x00\x00refs/remotes/origin/heads/test';
    const result = parseBranches(raw);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('origin/heads/test');
  });

  it('should parse non-current branch', () => {
    const raw = ' feature\x00def5678\x00\x00';
    const result = parseBranches(raw);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('feature');
    expect(result[0].current).toBe(false);
    expect(result[0].ahead).toBe(0);
    expect(result[0].behind).toBe(0);
  });

  it('flags upstreamGone when the tracked remote branch was deleted', () => {
    // git keeps the upstream config after the remote branch is deleted and
    // reports the track field as "gone".
    const raw = '*feature\x00abc1234\x00origin/feature\x00gone\x00refs/heads/feature';
    const result = parseBranches(raw);

    expect(result).toHaveLength(1);
    expect(result[0].upstream).toBe('origin/feature');
    expect(result[0].upstreamGone).toBe(true);
  });

  it('does not flag upstreamGone for a normally tracked branch', () => {
    const raw = '*main\x00abc1234\x00origin/main\x00ahead 1\x00refs/heads/main';
    const result = parseBranches(raw);

    expect(result[0].upstreamGone).toBeFalsy();
  });
});

describe('parseTags', () => {
  it('should return empty array for empty input', () => {
    expect(parseTags('')).toEqual([]);
  });

  it('should parse lightweight tag', () => {
    const raw = 'v1.0\x00abc1234\x00commit\x00\x00\x01\x02\x03';
    const result = parseTags(raw);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('v1.0');
    expect(result[0].isAnnotated).toBe(false);
    expect(result[0].message).toBeUndefined();
  });

  it('should parse annotated tag with subject only', () => {
    const raw = 'v2.0\x00def5678\x00tag\x00Release 2.0\x00\x01\x02\x03';
    const result = parseTags(raw);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('v2.0');
    expect(result[0].isAnnotated).toBe(true);
    expect(result[0].message).toBe('Release 2.0');
  });

  it('should parse annotated tag with subject and body', () => {
    const raw = 'v3.0\x00aaa1111\x00tag\x00Release 3.0\x00Bug fixes\nPerformance improvements\x01\x02\x03';
    const result = parseTags(raw);

    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('Release 3.0\n\nBug fixes\nPerformance improvements');
  });

  it('should parse multiple tags', () => {
    const raw = 'v1.0\x00abc1234\x00commit\x00\x00\x01\x02\x03v2.0\x00def5678\x00tag\x00Release 2.0\x00\x01\x02\x03';
    const result = parseTags(raw);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('v1.0');
    expect(result[1].name).toBe('v2.0');
  });
});

describe('parseRemotes', () => {
  it('should return empty array for empty input', () => {
    expect(parseRemotes('')).toEqual([]);
  });

  it('should parse remote with fetch and push', () => {
    const raw = 'origin\thttps://github.com/user/repo.git (fetch)\norigin\thttps://github.com/user/repo.git (push)';
    const result = parseRemotes(raw);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('origin');
    expect(result[0].fetchUrl).toBe('https://github.com/user/repo.git');
    expect(result[0].pushUrl).toBe('https://github.com/user/repo.git');
  });

  it('should parse multiple remotes', () => {
    const raw = [
      'origin\thttps://github.com/user/repo.git (fetch)',
      'origin\thttps://github.com/user/repo.git (push)',
      'upstream\thttps://github.com/org/repo.git (fetch)',
      'upstream\thttps://github.com/org/repo.git (push)',
    ].join('\n');
    const result = parseRemotes(raw);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('origin');
    expect(result[1].name).toBe('upstream');
  });
});

describe('parseStashList', () => {
  it('should return empty array for empty input', () => {
    expect(parseStashList('')).toEqual([]);
  });

  it('should parse stash entries with parent hash and hash', () => {
    const raw = 'stash@{0}\x00WIP on main: abc1234 Fix bug\x002024-01-15T10:00:00+09:00\x00aaa111 bbb222\x00fff000\nstash@{1}\x00On feature: save work\x002024-01-14T09:00:00+09:00\x00ccc333 ddd444\x00fff111';
    const result = parseStashList(raw);

    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[0].message).toBe('WIP on main: abc1234 Fix bug');
    expect(result[0].parentHash).toBe('aaa111');
    expect(result[0].hash).toBe('fff000');
    expect(result[1].index).toBe(1);
    expect(result[1].parentHash).toBe('ccc333');
    expect(result[1].hash).toBe('fff111');
  });
});

describe('parseDiff', () => {
  it('should return empty array for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('should parse a simple diff', () => {
    const raw = `diff --git a/src/app.ts b/src/app.ts
index abc123..def456 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 line1
-old line
+new line
+added line
 line3`;

    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/app.ts');
    expect(result[0].isBinary).toBe(false);
    expect(result[0].hunks).toHaveLength(1);
    expect(result[0].hunks[0].lines).toHaveLength(5);

    const lines = result[0].hunks[0].lines;
    expect(lines[0].type).toBe('context');
    expect(lines[1].type).toBe('delete');
    expect(lines[2].type).toBe('add');
    expect(lines[3].type).toBe('add');
    expect(lines[4].type).toBe('context');
  });

  it('should parse binary file diff', () => {
    const raw = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`;

    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].isBinary).toBe(true);
    expect(result[0].isImage).toBe(true);
  });

  it('should parse quoted path with octal escape (non-ASCII filename)', () => {
    // git quotes paths with non-ASCII chars and emits octal escapes. The
    // Korean filename "한글.txt" comes back as "\355\225\234\352\270\200.txt"
    // when wrapped in quotes. parseDiff must unescape it.
    const raw = [
      'diff --git "a/\\355\\225\\234\\352\\270\\200.txt" "b/\\355\\225\\234\\352\\270\\200.txt"',
      '--- "a/\\355\\225\\234\\352\\270\\200.txt"',
      '+++ "b/\\355\\225\\234\\352\\270\\200.txt"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('한글.txt');
  });

  it('parses unquoted path containing spaces', () => {
    // git does not quote paths that contain only spaces (no other special chars).
    // The header looks like "a/my file.txt b/my file.txt" — the regex must split
    // on the " b/" boundary, not the first whitespace.
    const raw = [
      'diff --git a/my file.txt b/my file.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('my file.txt');
  });

  it('parses unquoted path whose name contains a "b/" substring', () => {
    const raw = [
      'diff --git a/src/b/util.ts b/src/b/util.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/b/util.ts');
  });

  it('should parse quoted path with backslash escape', () => {
    const raw = [
      'diff --git "a/with\\ttab.txt" "b/with\\ttab.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('with\ttab.txt');
  });

  it('falls back to file param when header lacks a/b prefix', () => {
    // Some git config flags (`diff.noprefix=true`) strip the `a/` `b/`
    // prefixes from the diff header. parseDiff should still recover the
    // filename via the explicit `file` argument.
    const raw = `diff --git foo.ts foo.ts
--- foo.ts
+++ foo.ts
@@ -1 +1 @@
-x
+y`;
    const result = parseDiff(raw, 'foo.ts');
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('foo.ts');
  });

  it('resolves prefix-less (--no-prefix) paths from the +++ line', () => {
    // `git diff --no-prefix` emits no a//b/ prefix; the +++ line carries the
    // real path, so it should be used rather than falling back to "unknown".
    const raw = `diff --git foo.ts foo.ts
--- foo.ts
+++ foo.ts
@@ -1 +1 @@
-x
+y`;
    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('foo.ts');
  });

  it('falls back to "unknown" when there is no usable path anywhere', () => {
    // No a//b/ prefix and no +++/--- lines (mode-only style header).
    const raw = `diff --git foo.ts foo.ts
old mode 100644
new mode 100755`;
    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('unknown');
  });

  it('should parse multiple file diffs', () => {
    const raw = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,2 +1,2 @@
-old
+new
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1,2 +1,2 @@
-foo
+bar`;

    const result = parseDiff(raw);
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe('file1.ts');
    expect(result[1].file).toBe('file2.ts');
  });
});

describe('parseWorktreeList', () => {
  it('should return empty array for empty input', () => {
    expect(parseWorktreeList('')).toEqual([]);
    expect(parseWorktreeList('   ')).toEqual([]);
  });

  it('should parse a main worktree', () => {
    const raw = 'worktree /home/user/project\nHEAD abc123\nbranch refs/heads/main\n';
    const result = parseWorktreeList(raw);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/home/user/project');
    expect(result[0].hash).toBe('abc123');
    expect(result[0].branch).toBe('main');
    expect(result[0].isMain).toBe(true);
    expect(result[0].detached).toBe(false);
    expect(result[0].locked).toBe(false);
  });

  it('should parse multiple worktrees', () => {
    const raw =
      'worktree /home/user/project\nHEAD abc123\nbranch refs/heads/main\n\n' +
      'worktree /home/user/project-feat\nHEAD def456\nbranch refs/heads/feat/login\n';
    const result = parseWorktreeList(raw);
    expect(result).toHaveLength(2);
    expect(result[0].isMain).toBe(true);
    expect(result[0].branch).toBe('main');
    expect(result[1].isMain).toBe(false);
    expect(result[1].branch).toBe('feat/login');
  });

  it('should parse detached worktree', () => {
    const raw = 'worktree /home/user/project\nHEAD abc123\nbranch refs/heads/main\n\n' +
      'worktree /tmp/wt\nHEAD 789abc\ndetached\n';
    const result = parseWorktreeList(raw);
    expect(result[1].detached).toBe(true);
    expect(result[1].branch).toBe('');
  });

  it('should parse locked and prunable states', () => {
    const raw = 'worktree /home/user/project\nHEAD abc123\nbranch refs/heads/main\n\n' +
      'worktree /tmp/wt\nHEAD 789abc\nbranch refs/heads/test\nlocked\nprunable\n';
    const result = parseWorktreeList(raw);
    expect(result[1].locked).toBe(true);
    expect(result[1].prunable).toBe(true);
  });
});

describe('parseLfsFiles', () => {
  it('should return empty array for empty input', () => {
    expect(parseLfsFiles('')).toEqual([]);
    expect(parseLfsFiles('   ')).toEqual([]);
  });

  it('should parse files with * delimiter (downloaded)', () => {
    const raw = '7fa22a8f5f * banner.png\n5f70bf18a0 * data.bin\n';
    const result = parseLfsFiles(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ oid: '7fa22a8f5f', path: 'banner.png' });
    expect(result[1]).toEqual({ oid: '5f70bf18a0', path: 'data.bin' });
  });

  it('should parse files with - delimiter (not downloaded)', () => {
    const raw = '7fa22a8f5f - banner.png\n5f70bf18a0 - data.bin\n';
    const result = parseLfsFiles(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ oid: '7fa22a8f5f', path: 'banner.png' });
    expect(result[1]).toEqual({ oid: '5f70bf18a0', path: 'data.bin' });
  });

  it('should parse files with mixed delimiters', () => {
    const raw = '7fa22a8f5f * banner.png\n5f70bf18a0 - data.bin\n';
    const result = parseLfsFiles(raw);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('banner.png');
    expect(result[1].path).toBe('data.bin');
  });

  it('should parse files in subdirectories', () => {
    const raw = 'abc123 * assets/images/logo.png\n';
    const result = parseLfsFiles(raw);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('assets/images/logo.png');
  });

  it('should handle file names with spaces', () => {
    const raw = 'abc123 * my file.png\n';
    const result = parseLfsFiles(raw);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('my file.png');
  });
});

describe('parseLfsLocks', () => {
  it('should return empty array for empty input', () => {
    expect(parseLfsLocks('')).toEqual([]);
    expect(parseLfsLocks('   ')).toEqual([]);
  });

  it('should parse a single lock', () => {
    const raw = 'assets/logo.png\tuser1\tID:12345\n';
    const result = parseLfsLocks(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ path: 'assets/logo.png', owner: 'user1', id: 'ID:12345' });
  });

  it('should parse multiple locks', () => {
    const raw = 'logo.png\talice\tID:1\nbanner.png\tbob\tID:2\n';
    const result = parseLfsLocks(raw);
    expect(result).toHaveLength(2);
    expect(result[0].owner).toBe('alice');
    expect(result[1].owner).toBe('bob');
  });
});

describe('splitUpstreamRef', () => {
  it('splits remote from a simple branch', () => {
    expect(splitUpstreamRef('origin/main')).toEqual({ remote: 'origin', branch: 'main' });
  });

  it('keeps slashes in the branch portion (only the first segment is the remote)', () => {
    expect(splitUpstreamRef('origin/feature/login')).toEqual({ remote: 'origin', branch: 'feature/login' });
  });

  it('handles a custom remote name', () => {
    expect(splitUpstreamRef('upstream/release/2.0')).toEqual({ remote: 'upstream', branch: 'release/2.0' });
  });
});

