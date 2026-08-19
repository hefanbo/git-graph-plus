import { describe, it, expect } from 'vitest';
import {
  parseLog,
  parseShowRef,
  parseBranches,
  parseTags,
  parseRemotes,
  parseStashList,
  parseDiff,
  parseWorktreeList,
  parseLfsFiles,
  parseLfsLocks,
} from '../git-parser';

describe('parseLog — edge cases', () => {
  it('record without refs field produces empty refs array', () => {
    const raw = '\x01\x02\x03h\x00h\x00A\x00a@x.com\x002024-01-01\x00A\x00a@x.com\x002024-01-01\x00msg\x00\x00';
    const result = parseLog(raw);
    expect(result[0].refs).toEqual([]);
  });

  it('record with whitespace-only refs field produces empty refs array', () => {
    const raw = '\x01\x02\x03h\x00h\x00A\x00a@x.com\x002024-01-01\x00A\x00a@x.com\x002024-01-01\x00msg\x00\x00   ';
    const result = parseLog(raw);
    expect(result[0].refs).toEqual([]);
  });

  it('parses commit body when present', () => {
    const raw = '\x01\x02\x03h\x00h\x00A\x00a@x.com\x002024-01-01\x00A\x00a@x.com\x002024-01-01\x00subject\x00\x00body line\n\nmore';
    const result = parseLog(raw);
    expect(result[0].body).toBe('body line\n\nmore');
  });

  it('does not split a record when commit subject or body contains a stray \\x01', () => {
    // A contributor can put any unicode (including 0x01) in a commit subject
    // or body. The 3-byte sentinel \x01\x02\x03 must not be confused with
    // a lone \x01 in arbitrary content.
    const subjectWithSep = 'subject with \x01 inside';
    const bodyWithSep = 'body has \x01 byte and \x01 again';
    const raw =
      `\x01\x02\x03h1\x00h1\x00A\x00a@x.com\x002024-01-01\x00A\x00a@x.com\x002024-01-01\x00${subjectWithSep}\x00\x00${bodyWithSep}` +
      `\x01\x02\x03h2\x00h2\x00B\x00b@x.com\x002024-01-02\x00B\x00b@x.com\x002024-01-02\x00second\x00h1\x00\x00`;
    const result = parseLog(raw);
    expect(result).toHaveLength(2);
    expect(result[0].subject).toBe(subjectWithSep);
    expect(result[0].body).toBe(bodyWithSep);
    expect(result[1].hash).toBe('h2');
    expect(result[1].parents).toEqual(['h1']);
  });
});

describe('parseBranches — edge cases', () => {
  it('parses only-ahead and only-behind correctly', () => {
    const onlyAhead = parseBranches('*main\x00h\x00origin/main\x00ahead 3');
    expect(onlyAhead[0].ahead).toBe(3);
    expect(onlyAhead[0].behind).toBe(0);

    const onlyBehind = parseBranches(' feat\x00h\x00origin/feat\x00behind 5');
    expect(onlyBehind[0].ahead).toBe(0);
    expect(onlyBehind[0].behind).toBe(5);
  });

  it('drops entries whose name is empty', () => {
    const raw = ' \x00\x00\x00\n main\x00h\x00\x00\x00refs/heads/main';
    const result = parseBranches(raw);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('main');
  });

  it('treats empty upstream field as undefined', () => {
    const raw = ' feat\x00h\x00\x00';
    expect(parseBranches(raw)[0].upstream).toBeUndefined();
  });
});

describe('parseTags — edge cases', () => {
  it('annotated tag with body but no subject becomes undefined message', () => {
    // body-only is treated like no subject → no message
    const raw = 'v1\x00h\x00tag\x00\x00body only\x01\x02\x03';
    expect(parseTags(raw)[0].message).toBeUndefined();
  });
});

describe('parseRemotes — edge cases', () => {
  it('ignores malformed lines without a (fetch)/(push) suffix', () => {
    const raw = 'garbage line without suffix\norigin\thttps://x.git (fetch)';
    const result = parseRemotes(raw);
    expect(result).toHaveLength(1);
    expect(result[0].fetchUrl).toBe('https://x.git');
  });
});

describe('parseStashList — edge cases', () => {
  it('returns index 0 when refStr lacks the stash@{N} pattern', () => {
    const raw = 'malformed\x00msg\x00date\x00\x00';
    expect(parseStashList(raw)[0].index).toBe(0);
  });

  it('parentHash and hash are undefined when omitted', () => {
    const raw = 'stash@{0}\x00msg\x00date';
    const result = parseStashList(raw);
    expect(result[0].parentHash).toBeUndefined();
    expect(result[0].hash).toBeUndefined();
  });
});

describe('parseDiff — edge cases', () => {
  it('hunk header without explicit oldLines/newLines defaults to 1', () => {
    const raw = `diff --git a/f.ts b/f.ts
@@ -1 +1 @@
-x
+y`;
    const result = parseDiff(raw);
    expect(result[0].hunks[0].oldLines).toBe(1);
    expect(result[0].hunks[0].newLines).toBe(1);
  });

  it('non-image binary diff sets isImage=false', () => {
    const raw = `diff --git a/blob.bin b/blob.bin
Binary files a/blob.bin and b/blob.bin differ`;
    const result = parseDiff(raw);
    expect(result[0].isBinary).toBe(true);
    expect(result[0].isImage).toBe(false);
  });

  it('content lines before a hunk header are skipped (no currentHunk)', () => {
    const raw = `diff --git a/f.ts b/f.ts
some preamble
+ orphan add
@@ -1 +1 @@
-x
+y`;
    const result = parseDiff(raw);
    expect(result[0].hunks).toHaveLength(1);
    // Orphan "+ orphan add" must not appear among the parsed lines.
    const contents = result[0].hunks[0].lines.map(l => l.content);
    expect(contents).not.toContain(' orphan add');
  });

  it('treats blank lines inside a hunk as context', () => {
    const raw = `diff --git a/f.ts b/f.ts
@@ -1,3 +1,3 @@
 a

 c`;
    const result = parseDiff(raw);
    const ctxLines = result[0].hunks[0].lines.filter(l => l.type === 'context');
    expect(ctxLines).toHaveLength(3);
    expect(ctxLines[1].content).toBe('');
  });

  it('image extensions are detected case-insensitively', () => {
    const raw = `diff --git a/Logo.PNG b/Logo.PNG
Binary files a/Logo.PNG and b/Logo.PNG differ`;
    expect(parseDiff(raw)[0].isImage).toBe(true);
  });
});

describe('parseWorktreeList — edge cases', () => {
  it('skips blocks without a worktree path', () => {
    const raw = 'worktree /repo/main\nHEAD h\nbranch refs/heads/main\n\n\nHEAD h2\nbranch refs/heads/other\n';
    const result = parseWorktreeList(raw);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/repo/main');
  });

  it('handles "locked <reason>" and "prunable <reason>" prefixed forms', () => {
    const raw = 'worktree /repo/main\nHEAD h0\nbranch refs/heads/main\n\n' +
      'worktree /tmp/wt\nHEAD h1\nbranch refs/heads/x\nlocked because reasons\nprunable old worktree\n';
    const result = parseWorktreeList(raw);
    expect(result[1].locked).toBe(true);
    expect(result[1].prunable).toBe(true);
  });
});

describe('parseLog — defensive field fallbacks', () => {
  it('handles a record with all fields missing (every ?? "" branch)', () => {
    // RECORD_SEP only, no FIELD_SEP — fields[1..11] are undefined
    const raw = '\x01\x02\x03';
    const result = parseLog(raw);
    // Empty trimmed record is filtered out by parseLog
    expect(result).toEqual([]);
  });

  it('handles a record with only a hash (rest of fields undefined)', () => {
    const raw = '\x01\x02\x03abc123';
    const result = parseLog(raw);
    expect(result[0].hash).toBe('abc123');
    expect(result[0].abbreviatedHash).toBe('');
    expect(result[0].author.name).toBe('');
    expect(result[0].author.email).toBe('');
    expect(result[0].subject).toBe('');
    expect(result[0].body).toBe('');
    expect(result[0].parents).toEqual([]);
    expect(result[0].refs).toEqual([]);
  });

  it('strips trailing whitespace from hash field', () => {
    const raw = '\x01\x02\x03  hashy  \x00short\x00';
    expect(parseLog(raw)[0].hash).toBe('hashy');
  });
});

describe('parseBranches — defensive fallbacks', () => {
  it('handles a line with only a name (other fields undefined)', () => {
    const raw = ' lonely';
    const result = parseBranches(raw);
    expect(result[0].name).toBe('lonely');
    expect(result[0].hash).toBe('');
    expect(result[0].upstream).toBeUndefined();
    expect(result[0].ahead).toBe(0);
    expect(result[0].behind).toBe(0);
  });

  it('drops the trailing "heads/" prefix only when not a remote branch', () => {
    const raw = ' heads/foo\x00h\x00\x00\x00refs/heads/heads/foo';
    expect(parseBranches(raw)[0].name).toBe('foo');
  });
});

describe('parseTags — annotated tag edge cases', () => {
  it('handles a tag line with no fields beyond name', () => {
    const raw = 'v1';
    const result = parseTags(raw);
    expect(result[0].name).toBe('v1');
    expect(result[0].hash).toBe('');
    expect(result[0].isAnnotated).toBe(false);
  });
});

describe('parseStashList — defensive fallbacks', () => {
  it('handles a line with all fields missing except refStr', () => {
    const raw = 'stash@{0}';
    const result = parseStashList(raw);
    expect(result[0].index).toBe(0);
    expect(result[0].message).toBe('');
    expect(result[0].date).toBe('');
    expect(result[0].parentHash).toBeUndefined();
    expect(result[0].hash).toBeUndefined();
  });
});

describe('parseDiff — hunk header without context tail', () => {
  it('hunk header with no trailing context comment still parses lines', () => {
    const raw = `diff --git a/f.ts b/f.ts
@@ -10,2 +10,2 @@
 ctx
-old
+new`;
    const result = parseDiff(raw);
    expect(result[0].hunks).toHaveLength(1);
    expect(result[0].hunks[0].oldStart).toBe(10);
    expect(result[0].hunks[0].newStart).toBe(10);
  });

  it('hunk header missing whole new range falls back to defaults', () => {
    // Malformed: should still bail out (no hunkMatch) — produces empty hunks
    const raw = `diff --git a/f.ts b/f.ts
not a hunk
+line`;
    const result = parseDiff(raw);
    expect(result[0].hunks).toEqual([]);
  });

  it('resolves an unquoted path containing the " b/" substring via the +++ line', () => {
    // A directory literally named "weird b" makes the diff --git header
    // ambiguous (a/weird b/x.txt b/weird b/x.txt). The +++ line is the
    // unambiguous source of the post-image path.
    const raw = `diff --git a/weird b/x.txt b/weird b/x.txt
index e69de29..0cfbf08 100644
--- a/weird b/x.txt
+++ b/weird b/x.txt
@@ -0,0 +1 @@
+content`;
    const result = parseDiff(raw);
    expect(result[0].file).toBe('weird b/x.txt');
  });

  it('resolves a deleted file path from the --- line when +++ is /dev/null', () => {
    const raw = `diff --git a/weird b/x.txt b/weird b/x.txt
deleted file mode 100644
index 0cfbf08..0000000
--- a/weird b/x.txt
+++ /dev/null
@@ -1 +0,0 @@
-content`;
    const result = parseDiff(raw);
    expect(result[0].file).toBe('weird b/x.txt');
  });

  it('does not append a phantom context line for the trailing newline', () => {
    // git diff output ends with a newline; splitting on '\n' yields a final
    // empty string. That artifact must not become a context line in the last
    // hunk (which would also bump the trailing line numbers by one).
    const raw = `diff --git a/f.ts b/f.ts
@@ -1,2 +1,2 @@
 ctx
-old
+new
`;
    const result = parseDiff(raw);
    const lines = result[0].hunks[0].lines;
    expect(lines).toHaveLength(3); // ctx, -old, +new — no trailing empty
    const last = lines[lines.length - 1];
    expect(last.type).toBe('add');
    expect(last.content).toBe('new');
    expect(last.newLineNumber).toBe(2);
  });
});

describe('parseLfsFiles — defensive fallbacks', () => {
  it('handles lines without the recognized delimiter (single token)', () => {
    const raw = 'just-a-single-line';
    const result = parseLfsFiles(raw);
    expect(result[0]).toEqual({ oid: 'just-a-single-line', path: '' });
  });
});

describe('parseLfsLocks — defensive fallbacks', () => {
  it('handles lines missing some tab-separated fields', () => {
    const raw = 'path-only';
    const result = parseLfsLocks(raw);
    expect(result[0]).toEqual({ path: 'path-only', owner: '', id: '' });
  });

  it('handles lines with just path and owner (no id)', () => {
    const raw = 'logo.png\talice';
    const result = parseLfsLocks(raw);
    expect(result[0]).toEqual({ path: 'logo.png', owner: 'alice', id: '' });
  });
});

describe('parseDiff — git path unescaping edge cases', () => {
  it('decodes \\n, \\r, \\\\ and \\" escape forms in quoted paths', () => {
    const raw = [
      'diff --git "a/has\\nnewline.txt" "b/has\\nnewline.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseDiff(raw)[0].file).toBe('has\nnewline.txt');

    const raw2 = [
      'diff --git "a/back\\\\slash.txt" "b/back\\\\slash.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseDiff(raw2)[0].file).toBe('back\\slash.txt');

    const raw3 = [
      'diff --git "a/has\\rreturn.txt" "b/has\\rreturn.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseDiff(raw3)[0].file).toBe('has\rreturn.txt');

    const raw4 = [
      'diff --git "a/quoted\\".txt" "b/quoted\\".txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseDiff(raw4)[0].file).toBe('quoted".txt');
  });

  it('falls through unknown escape sequences to the literal character', () => {
    // \b is not in the recognised switch — should yield the literal "b".
    const raw = [
      'diff --git "a/foo\\bbar.txt" "b/foo\\bbar.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseDiff(raw)[0].file).toBe('foobbar.txt');
  });
});
