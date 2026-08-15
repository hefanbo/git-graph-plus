<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  interface Props {
    commit: string;
    onClose: () => void;
    onRestore: () => void;
  }

  let { commit, onClose, onRestore }: Props = $props();
  let restoreBtn: HTMLButtonElement | undefined = $state();

  onMount(() => { restoreBtn?.focus(); });
</script>

<Modal title={t('restore.title')} {onClose}>
  <p class="modal-desc">{t('restore.desc')}</p>
  <div class="modal-context-card">
    <span use:tooltip={commit} class="modal-pill modal-pill--danger"><i class="codicon codicon-git-commit"></i><span class="modal-pill-text">{commit.substring(0, 7)}</span></span>
  </div>
  <p class="modal-warning" role="alert"><i class="codicon codicon-warning"></i><span>{@html t('restore.warning')}</span></p>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="danger-btn" bind:this={restoreBtn} onclick={() => onRestore()}>{t('restore.restore')}</button>
  </div>
</Modal>
