import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import CommitGraph from '../CommitGraph.svelte';
import { commitStore } from '../../../lib/stores/commits.svelte';
import { branchStore } from '../../../lib/stores/branches.svelte';
import { uiStore } from '../../../lib/stores/ui.svelte';
import { modalStore } from '../../../lib/stores/modals.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { Commit, CommitGraphData } from '../../../lib/types';

function makeCommit(hash: string, subject: string, parents: string[] = []): Commit {
  return {
    hash,
    abbreviatedHash: hash.slice(0, 7),
    author: { name: 'A', email: 'a@x.com', date: '2024-01-01T00:00:00+00:00' },
    committer: { name: 'A', email: 'a@x.com', date: '2024-01-01T00:00:00+00:00' },
    subject,
    body: '',
    parents,
    refs: [],
  };
}

function makeGraphData(commits: Commit[]): CommitGraphData {
  return {
    commits,
    graph: commits.map(c => ({ commit: c.hash, column: 0, color: '#63b0f4', parents: [] })),
    paths: [],
    links: [],
    dots: commits.map((_, i) => ({ center: { x: 0, y: i }, color: 0, type: 'default' as const, localOnly: false, remoteTip: false })),
    commitLeftMargin: commits.map(() => 24),
    hasMore: false,
    currentLimit: 1000,
  };
}

beforeEach(() => {
  i18n.setLocale('en');
  // Reset shared singletons between tests.
  commitStore.commits = [];
  commitStore.graphNodes = [];
  commitStore.paths = [];
  commitStore.links = [];
  commitStore.dots = [];
  commitStore.commitLeftMargin = [];
  commitStore.loading = false;
  commitStore.notGitRepo = false;
  branchStore.branches = [];
  branchStore.worktrees = [];
  uiStore.selectedCommitHash = null;
  uiStore.selectedCommitHashes = [];
  uiStore.showBottomPanel = true;
  uiStore.comparing = false;
  uiStore.multiSelectArmed = false;
  uiStore.autoLoadMore = true;
  modalStore.closeAll();
});

afterEach(() => cleanup());

describe('CommitGraph smoke', () => {
  it('renders without crashing when commits are empty', () => {
    const { container } = render(CommitGraph, {});
    // No commit rows expected, but the container should exist.
    expect(container).toBeTruthy();
    expect(container.querySelectorAll('.commit-row').length).toBe(0);
  });

  it('renders one row per commit when commits are populated', async () => {
    commitStore.setData(makeGraphData([
      makeCommit('h1', 'first'),
      makeCommit('h2', 'second', ['h1']),
      makeCommit('h3', 'third', ['h2']),
    ]));
    const { container } = render(CommitGraph, {});
    await tick();
    expect(container.querySelectorAll('.commit-row').length).toBe(3);
  });

  it('clicking a commit row selects it immediately', async () => {
    commitStore.setData(makeGraphData([
      makeCommit('h1', 'first'),
      makeCommit('h2', 'second', ['h1']),
    ]));
    const { container } = render(CommitGraph, {});
    await tick();
    const rows = container.querySelectorAll<HTMLElement>('.commit-row');
    expect(rows.length).toBeGreaterThan(0);
    // There is no double-click action to disambiguate anymore, so no 150ms
    // delay before selection.
    await fireEvent.click(rows[0]);
    expect(uiStore.selectedCommitHash).toBe('h1');
  });

  it('clicking the UNCOMMITTED row opens the SCM view instead of selecting it', async () => {
    commitStore.setData(makeGraphData([
      makeCommit('UNCOMMITTED', 'Uncommitted changes'),
      makeCommit('h1', 'first'),
    ]));
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];
    const rows = container.querySelectorAll<HTMLElement>('.commit-row');
    await fireEvent.click(rows[0]);
    await tick();
    expect(globalThis.__postedMessages.some(m => (m.data as { type?: string }).type === 'openScmView')).toBe(true);
    expect(uiStore.selectedCommitHash).toBeNull();
  });

  it('right-clicking the UNCOMMITTED row opens an Amend menu, then the amend modal + SCM', async () => {
    const { modalStore } = await import('../../../lib/stores/modals.svelte');
    const head = makeCommit('h1', 'first');
    head.refs = [{ type: 'head', name: 'main' }];
    commitStore.setData(makeGraphData([
      makeCommit('UNCOMMITTED', 'Uncommitted changes'),
      head,
    ]));
    branchStore.branches = [
      { name: 'main', current: true, ahead: 1, behind: 0, hash: 'h1' },
    ];
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[0];
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();
    // The single menu item is "Amend '{ref}'" (ref = current branch); click it.
    const item = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .find(el => el.children.length === 0 && /^amend 'main'$/i.test((el.textContent ?? '').trim()));
    expect(item).toBeTruthy();
    await fireEvent.click(item!);
    await tick();
    expect(modalStore.amend.show).toBe(true);
    expect(modalStore.amend.hash).toBe('h1');
    expect(globalThis.__postedMessages.some(m => (m.data as { type?: string }).type === 'openScmView')).toBe(true);
    modalStore.closeAmend();
  });

  it('right-clicking the HEAD commit opens the amend modal + SCM', async () => {
    const { modalStore } = await import('../../../lib/stores/modals.svelte');
    const head = makeCommit('h2', 'latest', ['h1']);
    head.refs = [{ type: 'head', name: 'main' }];
    commitStore.setData(makeGraphData([head, makeCommit('h1', 'first')]));
    branchStore.branches = [
      { name: 'main', current: true, ahead: 1, behind: 0, hash: 'h2' },
    ];
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[0]; // HEAD row
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();
    const item = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .find(el => el.children.length === 0 && /^amend commit$/i.test((el.textContent ?? '').trim()));
    expect(item).toBeTruthy();
    await fireEvent.click(item!);
    await tick();
    expect(modalStore.amend.show).toBe(true);
    expect(modalStore.amend.hash).toBe('h2');
    expect(globalThis.__postedMessages.some(m => (m.data as { type?: string }).type === 'openScmView')).toBe(true);
    modalStore.closeAmend();
  });

  it('offers "Create worktree from" on a regular branch and posts startPoint', async () => {
    const head = makeCommit('h1', 'first');
    head.refs = [{ type: 'head', name: 'main' }];
    const feat = makeCommit('h2', 'feat work', ['h1']);
    feat.refs = [{ type: 'branch', name: 'develop' }];
    commitStore.setData(makeGraphData([feat, head]));
    branchStore.branches = [
      { name: 'main', current: true, ahead: 0, behind: 0, hash: 'h1' },
      { name: 'develop', current: false, ahead: 0, behind: 0, hash: 'h2' },
    ];
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[0]; // develop row
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();
    // The branch "develop" is a submenu-parent; hover over it to reveal children.
    const parentBtn = Array.from(container.querySelectorAll<HTMLElement>('button.menu-item.has-children'))
      .find(el => (el.textContent ?? '').includes('develop'));
    if (parentBtn) {
      await fireEvent.mouseEnter(parentBtn);
      await tick();
    }
    const item = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .find(el => el.children.length === 0 && /^new worktree$/i.test((el.textContent ?? '').trim()));
    expect(item).toBeTruthy();
    await fireEvent.click(item!);
    await tick();
    const msg = globalThis.__postedMessages
      .map(m => m.data as { type?: string; payload?: { startPoint?: string } })
      .find(m => m.type === 'worktreeAddModalRequest');
    expect(msg?.payload?.startPoint).toBe('develop');
  });

  it('offers a top-level "Create worktree from" item (no submenu hover needed) and posts startPoint', async () => {
    const head = makeCommit('h1', 'first');
    head.refs = [{ type: 'head', name: 'main' }];
    const feat = makeCommit('h2', 'feat work', ['h1']);
    feat.refs = [{ type: 'branch', name: 'develop' }];
    commitStore.setData(makeGraphData([feat, head]));
    branchStore.branches = [
      { name: 'main', current: true, ahead: 0, behind: 0, hash: 'h1' },
      { name: 'develop', current: false, ahead: 0, behind: 0, hash: 'h2' },
    ];
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[0]; // develop row
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();
    // Top-level (flat) item is present WITHOUT hovering into the branch submenu.
    const item = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .find(el => el.children.length === 0 && /^new worktree$/i.test((el.textContent ?? '').trim()));
    expect(item).toBeTruthy();
    await fireEvent.click(item!);
    await tick();
    const msg = globalThis.__postedMessages
      .map(m => m.data as { type?: string; payload?: { startPoint?: string } })
      .find(m => m.type === 'worktreeAddModalRequest');
    expect(msg?.payload?.startPoint).toBe('develop');
  });

  it('does not crash on a branch-set fingerprint cache hit (same commits, same branch)', async () => {
    // First mount populates the cache.
    commitStore.setData(makeGraphData([
      makeCommit('h1', 'first'),
      makeCommit('h2', 'second', ['h1']),
    ]));
    // currentBranch is a getter — set it by adding a current branch to the list.
    branchStore.branches = [
      { name: 'main', current: true, remote: undefined, upstream: undefined, ahead: 0, behind: 0, hash: 'h2' },
    ];

    const { container } = render(CommitGraph, {});
    await tick();
    expect(container.querySelectorAll('.commit-row').length).toBe(2);

    // Re-render with the SAME data — the fingerprint must match, no errors.
    cleanup();
    const { container: c2 } = render(CommitGraph, {});
    await tick();
    expect(c2.querySelectorAll('.commit-row').length).toBe(2);
  });
});

describe('CommitGraph — merge from commit', () => {
  it('offers "Merge into" for a ref-less commit not on the current branch, using its hash', async () => {
    // h1 is the current branch tip; h2 is a plain (ref-less) descendant commit,
    // so not reachable from main and mergeable by hash.
    const h0 = makeCommit('h0', 'old plain');
    const h1 = makeCommit('h1', 'tip', ['h0']);
    h1.refs = [{ type: 'head', name: 'main' }];
    const h2 = makeCommit('h2', 'plain side commit', ['h1']);
    commitStore.setData(makeGraphData([h2, h1, h0]));
    branchStore.branches = [
      { name: 'main', current: true, ahead: 0, behind: 0, hash: 'h1' },
    ];
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[0]; // h2
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();
    const item = Array.from(container.querySelectorAll<HTMLElement>('button.menu-item'))
      .find(el => /^Merge into 'main'$/.test((el.textContent ?? '').trim()));
    expect(item).toBeTruthy();
    await fireEvent.click(item!);
    await tick();
    expect(modalStore.merge.show).toBe(true);
    expect(modalStore.merge.source).toBe('h2');
    expect(modalStore.merge.target).toBe('main');
    modalStore.closeMerge();
  });

  it('hides "Merge into" for a ref-less commit that is an ancestor of the current branch tip', async () => {
    // h0 is a plain commit reachable from main (an ancestor of the tip), so
    // merging it would be an "Already up to date" no-op and the item must hide.
    const h0 = makeCommit('h0', 'ancestor plain');
    const h1 = makeCommit('h1', 'tip', ['h0']);
    h1.refs = [{ type: 'head', name: 'main' }];
    commitStore.setData(makeGraphData([h1, h0]));
    branchStore.branches = [
      { name: 'main', current: true, ahead: 0, behind: 0, hash: 'h1' },
    ];
    const { container } = render(CommitGraph, {});
    await tick();
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[1]; // h0
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();
    const items = Array.from(container.querySelectorAll<HTMLElement>('button.menu-item'));
    expect(items.some(el => /^Merge into 'main'$/.test((el.textContent ?? '').trim()))).toBe(false);
  });
});

describe('CommitGraph signature icon', () => {
  it('renders a signature icon for good/unverified commits', async () => {
    commitStore.setData(makeGraphData([
      { ...makeCommit('h1', 'signed'), signatureStatus: 'good' },
      { ...makeCommit('h2', 'tampered', ['h1']), signatureStatus: 'unverified' },
    ]));
    const { container } = render(CommitGraph, {});
    await tick();
    expect(container.querySelector('.sig-icon.sig-icon-good')).toBeTruthy();
    expect(container.querySelector('.sig-icon.sig-icon-unverified')).toBeTruthy();
  });

  it('omits the icon for "none" and when signatureStatus is absent', async () => {
    commitStore.setData(makeGraphData([
      { ...makeCommit('h1', 'unsigned'), signatureStatus: 'none' },
      makeCommit('h2', 'no field', ['h1']),
    ]));
    const { container } = render(CommitGraph, {});
    await tick();
    expect(container.querySelector('.sig-icon')).toBeFalsy();
  });

  it('shows "Interactive Rebase selected commits" for a contiguous chain on a non-current branch', async () => {
    const head = makeCommit('h1', 'main tip');
    head.refs = [{ type: 'head', name: 'main' }];
    const f1 = makeCommit('f1', 'feature 1', ['h1']);
    const f2 = makeCommit('f2', 'feature 2', ['f1']);
    f2.refs = [{ type: 'branch', name: 'feature' }];
    commitStore.setData(makeGraphData([f2, f1, head]));
    branchStore.branches = [
      { name: 'main', current: true, ahead: 0, behind: 0, hash: 'h1' },
      { name: 'feature', current: false, ahead: 0, behind: 0, hash: 'f2' },
    ];
    uiStore.multiSelectArmed = true;
    uiStore.selectedCommitHashes = ['f1', 'f2'];

    const { container } = render(CommitGraph, {});
    await tick();
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[0]; // f2 row
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();

    const item = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .find(el => el.children.length === 0 && /^interactive rebase \d+ commits$/i.test((el.textContent ?? '').trim()));
    expect(item).toBeTruthy();

    uiStore.exitMultiSelect();
  });

  it('keeps the right-clicked commit outlined while a context-menu modal is open, then clears it on close', async () => {
    // Regression: opening a modal from the context menu (e.g. New Branch, which
    // is managed by modalStore and rendered in App.svelte) used to clear the
    // row outline immediately — reset kept it, these did not. The outline must
    // persist while any follow-up modal is open and drop once it closes.
    commitStore.setData(makeGraphData([
      makeCommit('h1', 'first'),
      makeCommit('h2', 'second', ['h1']),
    ]));
    const { container } = render(CommitGraph, {});
    await tick();
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[0];
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();
    expect(container.querySelector('.commit-row.highlighted')).toBeTruthy();

    const item = Array.from(container.querySelectorAll<HTMLElement>('.menu-item'))
      .find(el => (el.textContent ?? '').trim() === 'New Branch');
    expect(item).toBeTruthy();
    await fireEvent.click(item!);
    await tick();

    expect(modalStore.createBranch.show).toBe(true);
    expect(container.querySelector('.commit-row.highlighted')).toBeTruthy();

    modalStore.closeCreateBranch();
    await tick();
    expect(container.querySelector('.commit-row.highlighted')).toBeFalsy();
  });

  it('keeps the right-clicked commit outlined when opening interactive rebase from the single-commit menu', async () => {
    // Regression: interactiveRebaseBase is only mirrored into modalStore via an
    // $effect, which runs after the synchronous menu onClose. The outline used
    // to clear because anyModalOpen still read false at that point.
    const c1 = makeCommit('h1', 'first');
    const c2 = makeCommit('h2', 'second', ['h1']);
    c2.refs = [{ type: 'head', name: 'main' }];
    commitStore.setData(makeGraphData([c2, c1]));
    branchStore.branches = [{ name: 'main', current: true, ahead: 0, behind: 0, hash: 'h2' }];
    uiStore.interactiveRebaseMode = 'ui';

    const { container } = render(CommitGraph, {});
    await tick();
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[1]; // h1 row
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();
    expect(container.querySelector('.commit-row.highlighted')).toBeTruthy();

    const item = Array.from(container.querySelectorAll<HTMLElement>('.menu-item'))
      .find(el => /^interactively rebase .* to here$/i.test((el.textContent ?? '').trim()));
    expect(item).toBeTruthy();
    await fireEvent.click(item!);
    await tick();

    expect(container.querySelector('.commit-row.highlighted')).toBeTruthy();

    uiStore.exitMultiSelect();
  });

  it('keeps the multi-selection armed after opening the interactive rebase modal (GUI mode)', async () => {
    // Regression: clicking "Interactive Rebase selected commits" used to clear
    // the selection the moment the modal opened. Like squash/cherry-pick, the
    // selection must persist while the modal is open.
    const base = makeCommit('m0', 'base');
    const c1 = makeCommit('c1', 'commit 1', ['m0']);
    const c2 = makeCommit('c2', 'commit 2', ['c1']);
    c2.refs = [{ type: 'head', name: 'main' }];
    commitStore.setData(makeGraphData([c2, c1, base]));
    branchStore.branches = [
      { name: 'main', current: true, ahead: 0, behind: 0, hash: 'c2' },
    ];
    uiStore.interactiveRebaseMode = 'ui';
    uiStore.multiSelectArmed = true;
    uiStore.selectedCommitHashes = ['c1', 'c2'];

    const { container } = render(CommitGraph, {});
    await tick();
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[0]; // c2 row
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();

    const item = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .find(el => el.children.length === 0 && /^interactive rebase \d+ commits$/i.test((el.textContent ?? '').trim()));
    expect(item).toBeTruthy();
    await fireEvent.click(item!);
    await tick();

    expect(uiStore.multiSelectArmed).toBe(true);
    expect(uiStore.selectedCommitHashes).toEqual(['c1', 'c2']);

    uiStore.exitMultiSelect();
  });

  it('resolves candidate branches when BranchInfo.hash is abbreviated (not the full commit hash)', async () => {
    // Regression: branch tips come from git as %(objectname:short), but commitMap
    // is keyed by the full hash. The menu item must still appear.
    const head = makeCommit('mainfull1234', 'main tip');
    head.refs = [{ type: 'head', name: 'main' }];
    const f1 = makeCommit('feat1full5678', 'feature 1', ['mainfull1234']);
    const f2 = makeCommit('feat2full9012', 'feature 2', ['feat1full5678']);
    f2.refs = [{ type: 'branch', name: 'feature' }];
    commitStore.setData(makeGraphData([f2, f1, head]));
    // abbreviated tips (commit.abbreviatedHash === hash.slice(0,7)), which differ
    // from the full commit hashes the commitMap is keyed by.
    branchStore.branches = [
      { name: 'main', current: true, ahead: 0, behind: 0, hash: 'mainful' },
      { name: 'feature', current: false, ahead: 0, behind: 0, hash: 'feat2fu' },
    ];
    uiStore.multiSelectArmed = true;
    uiStore.selectedCommitHashes = ['feat1full5678', 'feat2full9012'];

    const { container } = render(CommitGraph, {});
    await tick();
    const row = container.querySelectorAll<HTMLElement>('.commit-row')[0]; // f2 row
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();

    const item = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .find(el => el.children.length === 0 && /^interactive rebase \d+ commits$/i.test((el.textContent ?? '').trim()));
    expect(item).toBeTruthy();

    uiStore.exitMultiSelect();
  });
});

describe('CommitGraph — ref badges', () => {
  const badgeTexts = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('.ref-badge')).map(el => (el.textContent ?? '').trim());
  const sourceTexts = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('.badge-source')).map(el => (el.textContent ?? '').trim());

  it('merges same-named local and remote refs into one badge listing every source', async () => {
    const c = makeCommit('h1', 'work');
    c.refs = [
      { type: 'branch', name: 'feature-x' },
      { type: 'remote-branch', name: 'feature-x', remote: 'origin' },
    ];
    commitStore.setData(makeGraphData([c]));
    const { container } = render(CommitGraph, {});
    await tick();

    expect(container.querySelectorAll('.ref-badge').length).toBe(1);
    // Sources: ☁origin then the local folder marker, separated by whitespace;
    // a bar separates the sources from the branch name.
    expect(sourceTexts(container)).toEqual(['origin', '']);
    expect(badgeTexts(container)[0]).not.toContain('·');
    expect(container.querySelectorAll('.badge-divider').length).toBe(1);
    expect(container.querySelector('.codicon-folder')).toBeTruthy();
    expect(badgeTexts(container)[0]).toContain('feature-x');
  });

  it('lists multiple remotes alphabetically with the local marker last', async () => {
    const c = makeCommit('h1', 'work');
    c.refs = [
      { type: 'head', name: 'master' },
      { type: 'remote-branch', name: 'master', remote: 'upstream' },
      { type: 'remote-branch', name: 'master', remote: 'origin' },
    ];
    commitStore.setData(makeGraphData([c]));
    const { container } = render(CommitGraph, {});
    await tick();

    expect(sourceTexts(container)).toEqual(['origin', 'upstream', '']);
    expect(container.querySelectorAll('.badge-divider').length).toBe(1);
    expect(container.querySelector('.codicon-check')).toBeTruthy();
    expect(container.querySelectorAll('.ref-badge').length).toBe(1);
  });

  it('sorts branch badges alphabetically and renders tags first, stashes last', async () => {
    const c = makeCommit('h1', 'work');
    c.refs = [
      { type: 'branch', name: 'myfix' },
      { type: 'remote-branch', name: 'chore/next', remote: 'origin' },
      { type: 'tag', name: 'v1' },
      { type: 'stash', name: 'stash@{0}' },
    ];
    commitStore.setData(makeGraphData([c]));
    const { container } = render(CommitGraph, {});
    await tick();

    const texts = badgeTexts(container);
    expect(texts.length).toBe(4);
    expect(texts[0]).toContain('v1');               // tag first
    expect(texts[1]).toContain('chore/next');       // alphabetical branch group
    expect(texts[2]).toContain('myfix');
    expect(texts[3]).toContain('stash@{0}');        // stash last
  });

  it('renders a remote-only badge with cloud + remote name and no local marker', async () => {
    const c = makeCommit('h1', 'work');
    c.refs = [{ type: 'remote-branch', name: 'feat/ui', remote: 'origin' }];
    commitStore.setData(makeGraphData([c]));
    const { container } = render(CommitGraph, {});
    await tick();

    expect(sourceTexts(container)).toEqual(['origin']);
    // A single source needs no separator, only the bar before the branch name.
    expect(container.querySelectorAll('.badge-divider').length).toBe(1);
    expect(container.querySelector('.codicon-folder')).toBeFalsy();
    expect(badgeTexts(container)[0]).toContain('feat/ui');
  });

  it('renders a local-only badge without sources or separators', async () => {
    const c = makeCommit('h1', 'work');
    c.refs = [{ type: 'branch', name: 'fix/user' }];
    commitStore.setData(makeGraphData([c]));
    const { container } = render(CommitGraph, {});
    await tick();

    expect(sourceTexts(container)).toEqual([]);
    expect(container.querySelectorAll('.badge-divider').length).toBe(0);
    expect(badgeTexts(container)[0]).toContain('fix/user');
  });

  it('filters sources with remoteFilter before grouping', async () => {
    const c = makeCommit('h1', 'work');
    c.refs = [
      { type: 'branch', name: 'master' },
      { type: 'remote-branch', name: 'master', remote: 'origin' },
      { type: 'remote-branch', name: 'master', remote: 'upstream' },
    ];
    commitStore.setData(makeGraphData([c]));
    const { container } = render(CommitGraph, { remoteFilter: ['origin'] });
    await tick();

    expect(sourceTexts(container)).toEqual(['origin']);
    expect(container.querySelector('.codicon-folder')).toBeFalsy();
    expect(badgeTexts(container)[0]).toContain('master');
  });

  it('marks a worktree-linked local branch with the worktree icon', async () => {
    const c = makeCommit('h1', 'work');
    c.refs = [{ type: 'branch', name: 'wt' }];
    commitStore.setData(makeGraphData([c]));
    branchStore.worktrees = [
      { path: '/wt', hash: 'h1', branch: 'wt', detached: false, locked: false, prunable: false, isMain: false },
    ];
    const { container } = render(CommitGraph, {});
    await tick();

    expect(container.querySelector('.codicon-worktree')).toBeTruthy();
  });
});

describe('CommitGraph — keyboard actions', () => {
  it('first arrow navigation selects the top commit without opening the details panel', async () => {
    commitStore.setData(makeGraphData([
      makeCommit('h1', 'first'),
      makeCommit('h2', 'second', ['h1']),
    ]));
    uiStore.selectedCommitHash = null;
    // The flag defaults to true, but no panel is on screen until a commit is
    // selected — browsing must not make it appear.
    uiStore.showBottomPanel = true;
    render(CommitGraph, {});
    await tick();

    await fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(uiStore.selectedCommitHash).toBe('h1');
    expect(uiStore.showBottomPanel).toBe(false);
  });

  it('Enter on the already-selected row opens the details panel (no toggle-off)', async () => {
    commitStore.setData(makeGraphData([makeCommit('h1', 'first')]));
    const { container } = render(CommitGraph, {});
    await tick();
    const row = container.querySelector<HTMLElement>('.commit-row')!;
    await fireEvent.click(row);
    uiStore.showBottomPanel = false; // user closed it

    await fireEvent.keyDown(row, { key: 'Enter' });

    expect(uiStore.selectedCommitHash).toBe('h1');
    expect(uiStore.showBottomPanel).toBe(true);
  });

  it('arrow navigation moves selection and focus without opening a closed details panel', async () => {
    commitStore.setData(makeGraphData([
      makeCommit('h1', 'first'),
      makeCommit('h2', 'second', ['h1']),
    ]));
    const { container } = render(CommitGraph, {});
    await tick();
    const rows = container.querySelectorAll<HTMLElement>('.commit-row');
    await fireEvent.click(rows[0]);   // select h1 (a click opens the panel)
    uiStore.showBottomPanel = false;  // user hid it

    await fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(uiStore.selectedCommitHash).toBe('h2');
    expect(uiStore.showBottomPanel).toBe(false);
    // Focus follows the selection so Enter can reopen the details for it.
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('data-hash')).toBe('h2');
    });
  });

  it('arrow navigation keeps an open details panel open', async () => {
    commitStore.setData(makeGraphData([
      makeCommit('h1', 'first'),
      makeCommit('h2', 'second', ['h1']),
    ]));
    const { container } = render(CommitGraph, {});
    await tick();
    await fireEvent.click(container.querySelectorAll<HTMLElement>('.commit-row')[0]);
    uiStore.showBottomPanel = true;

    await fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(uiStore.selectedCommitHash).toBe('h2');
    expect(uiStore.showBottomPanel).toBe(true);
  });

  it('Enter selects the focused row, equivalent to a single click', async () => {
    commitStore.setData(makeGraphData([
      makeCommit('h1', 'first'),
      makeCommit('h2', 'second', ['h1']),
    ]));
    const { container } = render(CommitGraph, {});
    await tick();
    const rows = container.querySelectorAll<HTMLElement>('.commit-row');

    await fireEvent.keyDown(rows[1], { key: 'Enter' });
    expect(uiStore.selectedCommitHash).toBe('h2');
    expect(uiStore.showBottomPanel).toBe(true);
  });

  it('Enter on the UNCOMMITTED row opens SCM, like clicking it', async () => {
    commitStore.setData(makeGraphData([
      makeCommit('UNCOMMITTED', 'Uncommitted changes'),
      makeCommit('h1', 'first'),
    ]));
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];

    await fireEvent.keyDown(container.querySelector<HTMLElement>('.commit-row')!, { key: 'Enter' });

    expect(globalThis.__postedMessages.some(m => (m.data as { type?: string }).type === 'openScmView')).toBe(true);
    expect(uiStore.selectedCommitHash).toBeNull();
  });
});

describe('CommitGraph — no double-click actions', () => {
  it('double-clicking a row or badge does not checkout', async () => {
    const c = makeCommit('h1', 'work');
    c.refs = [
      { type: 'branch', name: 'feature-x' },
      { type: 'remote-branch', name: 'feature-x', remote: 'origin' },
    ];
    commitStore.setData(makeGraphData([c]));
    branchStore.branches = [
      { name: 'feature-x', current: true, upstream: 'origin/feature-x', ahead: 0, behind: 0, hash: 'h1' },
    ];
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];

    await fireEvent.doubleClick(container.querySelector<HTMLElement>('.commit-row')!);
    await fireEvent.doubleClick(container.querySelector<HTMLElement>('.ref-badge')!);
    await tick();

    expect(globalThis.__postedMessages.some(m => (m.data as { type?: string }).type === 'checkout')).toBe(false);
  });
});

describe('CommitGraph — auto-load on scroll', () => {
  function driveScrollToBottom(graph: HTMLElement) {
    // happy-dom does no layout, so clientHeight/scrollHeight/scrollTop stay 0;
    // set the scroll metrics directly to simulate a viewport scrolled to the
    // bottom (1800 + 200 === 2000, i.e. within LOAD_MORE_SCROLL_THRESHOLD).
    Object.defineProperty(graph, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(graph, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(graph, 'scrollTop', { value: 1800, configurable: true });
  }

  function getLogPosts() {
    return globalThis.__postedMessages.filter(
      (m) => (m.data as { type?: string }).type === 'getLog'
    );
  }

  it('scrolling to the bottom auto-posts getLog with the increased limit', async () => {
    commitStore.setData(makeGraphData([makeCommit('h1', 'first')]));
    commitStore.hasMore = true;
    commitStore.currentLimit = 50;
    uiStore.loadMoreCount = 50;
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];

    driveScrollToBottom(container.querySelector<HTMLElement>('.commit-graph')!);
    await fireEvent.scroll(container.querySelector<HTMLElement>('.commit-graph')!);
    // handleScroll defers the check to a requestAnimationFrame callback.
    await waitFor(() => {
      expect(getLogPosts().length).toBe(1);
    });
    expect((getLogPosts()[0].data as { payload: { limit: number } }).payload.limit).toBe(100);
  });

  it('carries the active scope into the load-more request', async () => {
    commitStore.setData(makeGraphData([makeCommit('h1', 'first')]));
    commitStore.hasMore = true;
    commitStore.currentLimit = 50;
    uiStore.loadMoreCount = 50;
    const { container } = render(CommitGraph, {
      remoteFilter: ['origin'],
      branchFilter: ['main'],
      includeReflog: true,
      simplifyByDecoration: true,
    });
    await tick();
    globalThis.__postedMessages = [];

    driveScrollToBottom(container.querySelector<HTMLElement>('.commit-graph')!);
    await fireEvent.scroll(container.querySelector<HTMLElement>('.commit-graph')!);
    await waitFor(() => {
      expect(getLogPosts().length).toBe(1);
    });
    expect((getLogPosts()[0].data as { payload: unknown }).payload).toEqual({
      limit: 100,
      branches: ['main'],
      remoteFilter: ['origin'],
      includeReflog: true,
      simplifyByDecoration: true,
    });
  });

  it('does not auto-load when scrolled well above the bottom', async () => {
    commitStore.setData(makeGraphData([makeCommit('h1', 'first')]));
    commitStore.hasMore = true;
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];

    const graph = container.querySelector<HTMLElement>('.commit-graph')!;
    Object.defineProperty(graph, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(graph, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(graph, 'scrollTop', { value: 500, configurable: true }); // 1300px of content still below
    await fireEvent.scroll(graph);
    await new Promise(r => setTimeout(r, 25)); // let the rAF check run
    expect(getLogPosts().length).toBe(0);
  });

  it('does not auto-load when the autoLoadMore setting is off', async () => {
    commitStore.setData(makeGraphData([makeCommit('h1', 'first')]));
    commitStore.hasMore = true;
    uiStore.autoLoadMore = false;
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];

    driveScrollToBottom(container.querySelector<HTMLElement>('.commit-graph')!);
    await fireEvent.scroll(container.querySelector<HTMLElement>('.commit-graph')!);
    await new Promise(r => setTimeout(r, 25));
    expect(getLogPosts().length).toBe(0);
  });

  it('does not auto-load while a load is already in progress', async () => {
    commitStore.setData(makeGraphData([makeCommit('h1', 'first')]));
    commitStore.hasMore = true;
    commitStore.setLoadingMore(true);
    const { container } = render(CommitGraph, {});
    await tick();
    globalThis.__postedMessages = [];

    driveScrollToBottom(container.querySelector<HTMLElement>('.commit-graph')!);
    await fireEvent.scroll(container.querySelector<HTMLElement>('.commit-graph')!);
    await new Promise(r => setTimeout(r, 25));
    expect(getLogPosts().length).toBe(0);
    commitStore.setLoadingMore(false);
  });
});
