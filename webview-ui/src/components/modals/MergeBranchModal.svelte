<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import ColorSelect from '../common/ColorSelect.svelte';
  import ConflictFilesPopover from '../common/ConflictFilesPopover.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { getVsCodeApi } from '../../lib/vscode-api';
  import { defaultsStore } from '../../lib/stores/defaults.svelte';
  import { isCommitHash, shortenRef } from '../../lib/utils/git-ref';

  interface Props {
    source: string;
    target: string;
    canDeleteSource?: boolean;
    onClose: () => void;
    onMerge: (options: { noFf: boolean; ffOnly: boolean; squash: boolean; strategyOurs: boolean; noCommit: boolean; pushAfter: boolean; deleteSource: boolean }) => void;
  }

  let { source, target, canDeleteSource = false, onClose, onMerge }: Props = $props();
  let mergeMode = $state<'default' | 'no-ff' | 'squash'>(defaultsStore.current.merge.mode);
  let pushAfter = $state(defaultsStore.current.merge.pushAfter);
  let deleteSource = $state(defaultsStore.current.merge.deleteSource);
  let strategyOurs = $state(defaultsStore.current.merge.strategyOurs);
  let noCommit = $state(defaultsStore.current.merge.noCommit);
  let mergeBtn: HTMLButtonElement | undefined = $state();

  let conflictPrediction = $state<{ hasConflict: boolean; files: string[] } | null>(null);

  onMount(() => {
    mergeBtn?.focus();
    const vscode = getVsCodeApi();
    const requestId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    vscode.postMessage({ type: 'predictConflicts', payload: { ours: target, theirs: source, requestId } });
    const handler = (event: MessageEvent) => {
      if (event.data.type !== 'conflictPrediction') { return; }
      if (event.data.payload?.requestId !== requestId) { return; }
      conflictPrediction = event.data.payload;
      window.removeEventListener('message', handler);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  });
</script>

<Modal title={t('merge.title')} {onClose}>
  <p class="modal-desc">{t('merge.desc')}</p>
  <div class="modal-context-card">
    <span use:tooltip={shortenRef(source)} class="modal-pill modal-pill--source"><i class="codicon {isCommitHash(source) ? 'codicon-git-commit' : 'codicon-git-branch'}"></i><span class="modal-pill-text">{shortenRef(source)}</span></span>
    <i class="codicon codicon-arrow-right" style="color: var(--text-secondary);"></i>
    <span use:tooltip={shortenRef(target)} class="modal-pill modal-pill--target"><i class="codicon {isCommitHash(target) ? 'codicon-git-commit' : 'codicon-git-branch'}"></i><span class="modal-pill-text">{shortenRef(target)}</span></span>
  </div>
  {#if !strategyOurs}
    <div class="modal-form-group">
      <span class="modal-field-label">{t('merge.mergeType')}</span>
      <ColorSelect
        options={[
          { value: 'default', label: t('merge.default'), color: '#4caf50' },
          { value: 'no-ff', label: t('merge.noFf'), color: '#2196f3', flag: '--no-ff' },
          { value: 'squash', label: t('merge.squash'), color: '#9c27b0', warning: t('merge.squashWarning'), flag: '--squash' },
        ]}
        value={mergeMode}
        onChange={(v) => { mergeMode = v as typeof mergeMode; }}
      />
    </div>
  {/if}
  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={strategyOurs} />
      <span>{t('merge.strategyOurs')}</span>
      <span class="modal-flag-badge">-s ours</span>
    </label>
  </div>
  {#if strategyOurs}
    <p class="modal-warning" role="alert"><i class="codicon codicon-warning"></i><span>{@html t('merge.strategyOursWarning')}</span></p>
  {/if}
  <div class="modal-form-group">
    <label class="modal-checkbox">
      <input type="checkbox" bind:checked={noCommit} />
      <span>{t('merge.noCommit')}</span>
      <span class="modal-flag-badge">--no-commit</span>
    </label>
  </div>
  {#if !noCommit}
    <div class="modal-form-group">
      <label class="modal-checkbox">
        <input type="checkbox" bind:checked={pushAfter} />
        <span>{t('merge.pushAfter')}</span>
      </label>
    </div>
  {/if}
  {#if canDeleteSource}
    <div class="modal-form-group">
      <label class="modal-checkbox">
        <input type="checkbox" bind:checked={deleteSource} />
        <span>{t('merge.deleteSource', { branch: source })}</span>
        <span class="modal-flag-badge">--delete</span>
      </label>
    </div>
  {/if}
  {#if canDeleteSource && deleteSource}
    <p class="modal-warning" role="alert"><i class="codicon codicon-warning"></i><span>{@html t('merge.deleteSourceWarning')}</span></p>
  {/if}
  <div class="form-actions">
    {#if !strategyOurs}
      <div class="conflict-status" class:is-warning={conflictPrediction?.hasConflict} class:is-success={conflictPrediction !== null && !conflictPrediction?.hasConflict}>
        {#if conflictPrediction === null}
          <span class="spinner"></span>
          <span>{t('merge.checkingConflicts')}</span>
        {:else if conflictPrediction.hasConflict}
          <ConflictFilesPopover files={conflictPrediction.files}>
            <i class="codicon codicon-warning"></i>
            <span>{@html t('merge.conflictWarning', { count: String(conflictPrediction.files.length) })}</span>
          </ConflictFilesPopover>
        {:else}
          <i class="codicon codicon-check modal-status-check"></i>
          <span>{t('merge.noConflict')}</span>
        {/if}
      </div>
    {/if}
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="primary" bind:this={mergeBtn} onclick={() => onMerge({
      noFf: strategyOurs ? false : mergeMode === 'no-ff',
      ffOnly: false,
      squash: strategyOurs ? false : mergeMode === 'squash',
      strategyOurs,
      noCommit,
      pushAfter: !noCommit && pushAfter,
      deleteSource: canDeleteSource && deleteSource,
    })}>{t('merge.merge')}</button>
  </div>
</Modal>

<style>
  .conflict-status {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: inherit;
    margin-right: auto;
    color: var(--text-secondary);
  }

  .conflict-status.is-warning { color: #f0a020; }
  .conflict-status.is-success { color: #4caf50; }
</style>
