<script lang="ts">
  import Modal from '../common/Modal.svelte';
  import { t } from '../../lib/i18n/index.svelte';

  interface Props {
    onClose: () => void;
    onConfirm: () => void;
  }

  let { onClose, onConfirm }: Props = $props();
</script>

<Modal title={t('reflog.expireTitle')} {onClose}>
  <p class="modal-desc">{@html t('reflog.expireConfirm')}</p>
  <p class="modal-warning" role="alert"><i class="codicon codicon-warning"></i><span>{t('reflog.expireWarning')}</span></p>
  <div class="form-actions">
    <button onclick={onClose}>{t('common.cancel')}</button>
    <button class="danger-btn" onclick={onConfirm}>{t('reflog.expireConfirmButton')}</button>
  </div>
</Modal>
