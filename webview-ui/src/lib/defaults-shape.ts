export interface ModalDefaults {
  push: { force: 'none' | 'with-lease' | 'force'; setUpstream: boolean; allTags: boolean };
  pull: { rebase: boolean; stash: boolean };
  fetch: { allRemotes: boolean };
  merge: { mode: 'default' | 'no-ff' | 'squash'; pushAfter: boolean; deleteSource: boolean; strategyOurs: boolean };
  rebase: { autostash: boolean; pushAfter: boolean };
  amend: { keepMessage: boolean; resetDate: boolean; resetAuthor: boolean; only: boolean; pushAfter: boolean };
  checkout: { dirty: 'keep' | 'stash' | 'discard' };
  checkoutRemote: { dirty: 'keep' | 'stash' | 'discard' };
  createBranch: { checkout: boolean; publish: boolean };
  createTag: { push: boolean };
  cherryPick: { noCommit: boolean; pushAfter: boolean };
  revert: { noCommit: boolean; pushAfter: boolean };
  reset: { mode: 'soft' | 'mixed' | 'hard' };
  stashSave: { includeUntracked: boolean; keepIndex: boolean };
  deleteBranch: { force: boolean; deleteRemote: boolean };
  deleteTag: { deleteRemote: boolean };
  removeWorktree: { deleteBranch: boolean };
}

export const DEFAULT_MODAL_DEFAULTS: ModalDefaults = {
  push: { force: 'none', setUpstream: true, allTags: false },
  pull: { rebase: true, stash: false },
  fetch: { allRemotes: false },
  merge: { mode: 'default', pushAfter: false, deleteSource: false, strategyOurs: false },
  rebase: { autostash: false, pushAfter: false },
  amend: { keepMessage: true, resetDate: false, resetAuthor: false, only: false, pushAfter: false },
  checkout: { dirty: 'keep' },
  checkoutRemote: { dirty: 'keep' },
  createBranch: { checkout: true, publish: false },
  createTag: { push: true },
  cherryPick: { noCommit: false, pushAfter: false },
  revert: { noCommit: false, pushAfter: false },
  reset: { mode: 'mixed' },
  stashSave: { includeUntracked: true, keepIndex: false },
  deleteBranch: { force: false, deleteRemote: false },
  deleteTag: { deleteRemote: false },
  removeWorktree: { deleteBranch: false },
};
