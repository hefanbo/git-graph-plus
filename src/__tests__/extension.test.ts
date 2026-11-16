import { describe, it, expect, vi, beforeEach } from 'vitest';

// extension.ts is the activation entry point — heavily vscode-bound. We can't
// run the real extension host, but we can verify the wiring: which commands and
// tree views get registered, the no-workspace fallback, and the pure git-path
// resolver. Everything it imports is stubbed so activate() runs to completion.
const H = vi.hoisted(() => ({
  registeredCommands: [] as string[],
  commandHandlers: {} as Record<string, (...args: unknown[]) => unknown>,
  treeViewsCreated: [] as string[],
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
  gitPathConfig: null as string | string[] | null,
  worktreeList: [] as Array<{ path: string; isMain: boolean }>,
  // Built-in git API stub, installed only by the tests that exercise the
  // active-editor repo-follow wiring.
  gitApi: undefined as unknown,
  activeEditorHandlers: [] as Array<(editor: unknown) => void>,
  gitServicePaths: [] as string[],
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section?: string) => ({
      get: (key: string, def?: unknown) => {
        if (section === 'git' && key === 'path') return H.gitPathConfig;
        return def;
      },
    }),
    get workspaceFolders() { return H.workspaceFolders; },
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
  },
  window: {
    createTreeView: (id: string) => { H.treeViewsCreated.push(id); return { description: '', dispose() {} }; },
    createOutputChannel: () => ({ appendLine: vi.fn(), dispose() {} }),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(async () => undefined),
    onDidChangeActiveTextEditor: (cb: (editor: unknown) => void) => {
      H.activeEditorHandlers.push(cb);
      return { dispose() {} };
    },
    activeTextEditor: undefined,
  },
  commands: {
    registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => { H.registeredCommands.push(id); H.commandHandlers[id] = cb; return { dispose() {} }; },
    executeCommand: vi.fn(),
  },
  extensions: {
    getExtension: (id: string) =>
      id === 'vscode.git' && H.gitApi
        ? { isActive: true, exports: { getAPI: () => H.gitApi } }
        : undefined,
  },
  l10n: { t: (s: string) => s },
  Uri: { joinPath: () => ({}), file: (p: string) => ({ fsPath: p }), parse: () => ({}) },
  ViewColumn: { One: 1 },
}));

vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('../git/git-binary', () => ({ setGitBinaryPath: vi.fn() }));
vi.mock('../panels/MainPanel', () => ({
  MainPanel: class {
    static currentPanel: unknown = undefined;
    static setExtraEnv = vi.fn();
    static setAvatarCacheDir = vi.fn();
    static createOrShow = vi.fn();
    static showModalWithPanel = vi.fn();
    static onSidebarRefresh: unknown = null;
    static onRepoChange: unknown = null;
  },
}));
vi.mock('../git/git-service', () => ({ GitService: class {
  constructor(path: string) { H.gitServicePaths.push(path); }
  setExtraEnv() {}
  setDefaultTimeout() {}
  get rootPath() { return '/repo'; }
  worktreeList() { return Promise.resolve(H.worktreeList); }
} }));
vi.mock('../services/file-watcher', () => ({ FileWatcher: class { enabled = true; suppress() {} dispose() {} } }));
const viewStub = () => ({ ViewProvider: undefined });
vi.mock('../views/branches-view', () => ({ BranchesViewProvider: class { refresh() {} dispose() {} setGitService() {} prefetch() { return Promise.resolve(); } getCurrentItem() { return null; } } }));
vi.mock('../views/remotes-view', () => ({ RemotesViewProvider: class { refresh() {} dispose() {} setGitService() {} prefetch() { return Promise.resolve(); } } }));
vi.mock('../views/tags-view', () => ({ TagsViewProvider: class { refresh() {} dispose() {} setGitService() {} prefetch() { return Promise.resolve(); } } }));
vi.mock('../views/stashes-view', () => ({ StashesViewProvider: class { refresh() {} dispose() {} setGitService() {} prefetch() { return Promise.resolve(); } } }));
vi.mock('../views/worktrees-view', () => ({ WorktreesViewProvider: class { refresh() {} dispose() {} setGitService() {} prefetch() { return Promise.resolve(); } } }));
vi.mock('../views/status-bar', () => ({ StatusBarManager: class { dispose() {} } }));
vi.mock('../services/repo-discovery', () => ({ RepoDiscoveryService: { discoverRepos: vi.fn(async () => []), clearCache: vi.fn() } }));
void viewStub;

import { activate, resolveConfiguredGitPath } from '../extension';
import { existsSync } from 'fs';

function makeContext() {
  return { subscriptions: [] as Array<{ dispose(): void }>, extensionUri: {} } as unknown as import('vscode').ExtensionContext;
}

beforeEach(() => {
  H.registeredCommands = [];
  H.commandHandlers = {};
  H.treeViewsCreated = [];
  H.workspaceFolders = undefined;
  H.gitPathConfig = null;
  H.worktreeList = [];
  H.gitApi = undefined;
  H.activeEditorHandlers = [];
  H.gitServicePaths = [];
  vi.mocked(existsSync).mockReturnValue(true);
});

describe('resolveConfiguredGitPath', () => {
  it('returns undefined when nothing is configured', () => {
    H.gitPathConfig = null;
    expect(resolveConfiguredGitPath()).toBeUndefined();
  });

  it('returns a single configured path when it exists', () => {
    H.gitPathConfig = '/usr/local/bin/git';
    vi.mocked(existsSync).mockReturnValue(true);
    expect(resolveConfiguredGitPath()).toBe('/usr/local/bin/git');
  });

  it('returns the first existing candidate from an array', () => {
    H.gitPathConfig = ['/missing/git', '/real/git'];
    vi.mocked(existsSync).mockImplementation((p) => p === '/real/git');
    expect(resolveConfiguredGitPath()).toBe('/real/git');
  });

  it('returns undefined when no configured candidate exists', () => {
    H.gitPathConfig = ['/a/git', '/b/git'];
    vi.mocked(existsSync).mockReturnValue(false);
    expect(resolveConfiguredGitPath()).toBeUndefined();
  });
});

describe('activate', () => {
  it('with no workspace folder, registers only the open fallbacks and no tree views', () => {
    H.workspaceFolders = undefined;
    const ctx = makeContext();
    activate(ctx);
    expect(H.registeredCommands).toContain('git-graph-plus.open');
    expect(H.registeredCommands).toContain('gitGraphPlus.open');
    expect(H.treeViewsCreated).toEqual([]);
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  it('with a workspace folder, registers the full command set and all five tree views', () => {
    H.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    const ctx = makeContext();
    expect(() => activate(ctx)).not.toThrow();

    for (const id of ['gitGraphPlus.open', 'gitGraphPlus.refresh', 'gitGraphPlus.fetch', 'gitGraphPlus.pull', 'gitGraphPlus.push', 'gitGraphPlus.createBranch']) {
      expect(H.registeredCommands).toContain(id);
    }
    expect(H.registeredCommands.length).toBeGreaterThan(15);
    expect(H.treeViewsCreated).toEqual([
      'gitGraphPlus.branches',
      'gitGraphPlus.remotes',
      'gitGraphPlus.tags',
      'gitGraphPlus.stashes',
      'gitGraphPlus.worktrees',
    ]);
  });

  it('addWorktree defaults beside the main worktree even when active repo is linked worktree', async () => {
    H.workspaceFolders = [{ uri: { fsPath: '/repos/project.worktrees/custom.worktrees' } }];
    H.worktreeList = [
      { path: '/repos/project', isMain: true },
      { path: '/repos/project.worktrees/custom.worktrees', isMain: false },
    ];
    const ctx = makeContext();
    activate(ctx);

    await H.commandHandlers['gitGraphPlus.addWorktree']();

    const { MainPanel } = await import('../panels/MainPanel');
    expect(MainPanel.showModalWithPanel).toHaveBeenCalledWith(ctx.extensionUri, {
      modal: 'addWorktree',
      defaultPath: '/repos/project.worktrees',
    });
  });
});

async function activateWithGitApi() {
  H.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
  H.gitApi = {
    repositories: [],
    onDidOpenRepository: () => ({ dispose() {} }),
    getRepository: () => ({ rootUri: { fsPath: '/other-repo' } }),
  };
  const ctx = makeContext();
  activate(ctx);
  // The built-in git API is reached through a promise chain; let it settle so
  // `onDidChangeActiveTextEditor` is registered and repo discovery has pinned
  // the default repo.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(H.activeEditorHandlers).toHaveLength(1);
  return ctx;
}

describe('active-editor repo follow', () => {
  it('follows the active editor for the sidebar without retargeting an open panel', async () => {
    await activateWithGitApi();
    const { MainPanel } = await import('../panels/MainPanel');
    const switchRepo = vi.fn();
    (MainPanel as unknown as { currentPanel: unknown }).currentPanel = { switchRepo };
    H.gitServicePaths = [];

    H.activeEditorHandlers[0]({ document: { uri: {} } });

    // The panel keeps its selected repo...
    expect(switchRepo).not.toHaveBeenCalled();
    // ...while the sidebar/active repo still follows the editor.
    expect(H.gitServicePaths).toContain('/other-repo');
    (MainPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  it('follows the active editor repo when the panel is closed', async () => {
    await activateWithGitApi();
    const { MainPanel } = await import('../panels/MainPanel');
    (MainPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
    H.gitServicePaths = [];

    H.activeEditorHandlers[0]({ document: { uri: {} } });

    expect(H.gitServicePaths).toContain('/other-repo');
  });
});

describe('open command repo selection', () => {
  it('opens a fresh panel on the default repo, ignoring the followed active repo', async () => {
    const ctx = await activateWithGitApi();
    const { MainPanel } = await import('../panels/MainPanel');
    (MainPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
    vi.mocked(MainPanel.createOrShow).mockClear();

    // Panel was closed and VS Code re-activated a file tab in another repo:
    // the passive follow moves activeRepoPath away from the default.
    H.gitServicePaths = [];
    H.activeEditorHandlers[0]({ document: { uri: {} } });
    expect(H.gitServicePaths).toContain('/other-repo');

    H.gitServicePaths = [];
    H.commandHandlers['gitGraphPlus.open']();

    expect(MainPanel.createOrShow).toHaveBeenCalledWith(ctx.extensionUri, '/repo');
    expect(H.gitServicePaths).toContain('/repo');
  });

  it('reveals an open panel without retargeting its repo', async () => {
    const ctx = await activateWithGitApi();
    const { MainPanel } = await import('../panels/MainPanel');
    vi.mocked(MainPanel.createOrShow).mockClear();
    const switchRepo = vi.fn();
    (MainPanel as unknown as { currentPanel: unknown }).currentPanel = { switchRepo };
    H.gitServicePaths = [];

    H.activeEditorHandlers[0]({ document: { uri: {} } });
    // Reset after the passive sidebar follow; the open command itself must not
    // create a service or switch repos.
    H.gitServicePaths = [];
    H.commandHandlers['gitGraphPlus.open']();

    expect(switchRepo).not.toHaveBeenCalled();
    expect(H.gitServicePaths).toEqual([]);
    expect(MainPanel.createOrShow).toHaveBeenCalledWith(ctx.extensionUri);
    (MainPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  it('honors an explicit SCM repo on a fresh open', async () => {
    const ctx = await activateWithGitApi();
    const { MainPanel } = await import('../panels/MainPanel');
    (MainPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
    vi.mocked(MainPanel.createOrShow).mockClear();

    H.commandHandlers['gitGraphPlus.open']({ rootUri: { fsPath: '/scm-repo' } });

    expect(MainPanel.createOrShow).toHaveBeenCalledWith(ctx.extensionUri, '/scm-repo');
  });
});
