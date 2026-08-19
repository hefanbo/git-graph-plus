// Shared, lazily-bound global handlers so each tooltip instance doesn't add its own
// window listeners (there can be hundreds of tooltips across the virtual-scrolled
// graph, and they churn on every row create/destroy).
//
// Tracks every instance with a tooltip that is either showing OR has a pending
// hover timer. Each entry's hide() cancels the timer and removes the element, so
// hideAll() dismisses both. Only one tooltip should ever be active at a time.
const activeTips = new Set<() => void>();
// Nodes that currently have a showing-or-pending tooltip. The commit-subject /
// ref-badge tooltips nest inside a row's fallback tooltip; while a nested one is
// under the pointer the fallback defers to it (see nestedTooltipActive), and only
// re-claims once the pointer moves onto a spot with no more-specific tooltip.
const activeNodes = new Set<HTMLElement>();
let globalsBound = false;

// Ref-counted suppression. While > 0, no tooltip may show — used by transient
// foreground overlays (e.g. the right-click context menu) that out-rank the
// tooltip's z-index and would otherwise be covered by a hover tooltip popping
// up over them. See suppressTooltips().
let suppressDepth = 0;

function hideAll() {
  // Copy first: hide() mutates the set.
  for (const h of [...activeTips]) h();
}

/**
 * Suppress all tooltips until the returned function is called. Hides anything
 * currently visible and blocks new tooltips (including pending hover timers)
 * for as long as the suppression is held. Ref-counted, so overlapping callers
 * each get their own release and tooltips resume only once all have released.
 */
export function suppressTooltips(): () => void {
  suppressDepth++;
  hideAll();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suppressDepth = Math.max(0, suppressDepth - 1);
  };
}

function bindGlobals() {
  if (globalsBound || typeof window === 'undefined') return;
  globalsBound = true;
  // Hide when the webview loses focus (Alt+Tab, clicking the VS Code sidebar, etc.)
  window.addEventListener('blur', hideAll);
  // Escape should always dismiss any visible tooltip, even when focus is trapped.
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideAll(); });
  // A native HTML5 drag (e.g. dragging a branch badge) does not fire mouseleave on
  // the dragged element in Chromium/Electron, so its tooltip would otherwise stay
  // stuck on screen. dragstart bubbles to window — dismiss everything when one begins.
  window.addEventListener('dragstart', hideAll);
}

export function tooltip(node: HTMLElement, text: string | undefined) {
  bindGlobals();

  let el: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let mouseX = 0;
  let mouseY = 0;
  let hovered = false;
  let pending = false; // a hover timer is armed but the tooltip isn't visible yet
  let visible = false;
  let listening = false;

  function position() {
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { width, height } = el.getBoundingClientRect();

    const OFFSET_X = 8;
    const OFFSET_Y = 14;

    let x = mouseX + OFFSET_X;
    let y = mouseY + OFFSET_Y;

    if (x + width > vw - 4) x = mouseX - width - OFFSET_X;
    if (y + height > vh - 4) y = mouseY - height - 4;

    el.style.left = `${Math.max(4, x)}px`;
    el.style.top = `${Math.max(4, y)}px`;
  }

  // True when a more-specific (nested) tooltip — or an actual tooltip div — is
  // under the pointer. Those out-rank this node's fallback while hovered.
  function nestedTooltipActive(e: MouseEvent): boolean {
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (!under) return false;
    for (let n = under as HTMLElement | null; n; n = n.parentElement) {
      if (n === node) return false;
      if (n.classList?.contains('vsg-tooltip')) return true;
      if (activeNodes.has(n)) return true;
    }
    return false;
  }

  function onMouseMove(e: MouseEvent) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (visible) { position(); return; }
    // A nested tooltip (e.g. the commit subject) preempted this fallback when we
    // were entered, so it never appeared. Moving onto a part of this node that
    // has no more-specific tooltip re-arms it — without this the fallback would
    // stay silent until the pointer re-enters the node.
    if (hovered && text && !pending && suppressDepth === 0 && !nestedTooltipActive(e)) {
      arm(e);
    }
  }

  // Bound only while it can do work: while visible (repositioning) or while
  // hovered with a fallback that could be re-claimed. The virtual-scrolled graph
  // churns hundreds of tooltips, so never hold a listener idle.
  function syncMousemove() {
    const need = visible || (hovered && !!text && !pending);
    if (need && !listening) {
      node.addEventListener('mousemove', onMouseMove);
      listening = true;
    } else if (!need && listening) {
      node.removeEventListener('mousemove', onMouseMove);
      listening = false;
    }
  }

  function arm(e: MouseEvent) {
    if (!text || suppressDepth > 0) return;
    hide();
    // Entering a nested tooltip element (e.g. a link inside the commit subject
    // span, which also has a tooltip) does not fire mouseleave on the ancestor,
    // so its tooltip would linger and overlap this one. mouseenter fires
    // ancestor-first, so dismissing every other active tooltip here leaves only
    // the innermost hovered element showing one.
    hideAll();
    activeNodes.add(node);
    pending = true;
    visible = false;
    mouseX = e.clientX;
    mouseY = e.clientY;
    // Register while still pending so a nested hover (or suppression) can cancel us.
    activeTips.add(hide);
    timer = setTimeout(() => {
      // A suppression (e.g. context menu) may have opened while we waited.
      if (suppressDepth > 0 || !hovered) { hide(); return; }
      pending = false;
      visible = true;
      el = document.createElement('div');
      el.className = 'vsg-tooltip';
      el.textContent = text ?? null;
      document.body.appendChild(el);
      position();
      syncMousemove();
    }, 500);
    syncMousemove();
  }

  function hide() {
    if (timer) { clearTimeout(timer); timer = null; }
    pending = false;
    visible = false;
    el?.remove();
    el = null;
    activeNodes.delete(node);
    activeTips.delete(hide);
    syncMousemove();
  }

  // Chromium/Electron does not fire mouseleave when `disabled` is set while hovering,
  // so a disabled control could leave its tooltip stuck. Only elements that can be
  // disabled need watching — skip the observer for the many plain span/div tooltips.
  let observer: MutationObserver | null = null;
  if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) {
    observer = new MutationObserver(() => {
      if ((node as HTMLButtonElement).disabled) hide();
    });
    observer.observe(node, { attributes: true, attributeFilter: ['disabled'] });
  }

  function onMouseEnter(e: MouseEvent) {
    hovered = true;
    arm(e);
  }

  function onMouseLeave() {
    hovered = false;
    hide();
  }

  node.addEventListener('mouseenter', onMouseEnter);
  node.addEventListener('mouseleave', onMouseLeave);

  return {
    update(t: string | undefined) {
      text = t;
      if (visible && t) { el!.textContent = t; position(); }
      else if (!t) { hide(); }
      syncMousemove();
    },
    destroy() {
      hide();
      observer?.disconnect();
      node.removeEventListener('mouseenter', onMouseEnter);
      node.removeEventListener('mouseleave', onMouseLeave);
    }
  };
}
