import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tooltip, suppressTooltips } from '../tooltip';

function makeNode(): HTMLButtonElement {
  const btn = document.createElement('button');
  document.body.appendChild(btn);
  return btn;
}

function mouseEvent(type: string, x = 100, y = 100): MouseEvent {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
}

// mouseenter/mouseleave do not bubble in real browsers; for nested-element tests
// bubbling would re-fire an ancestor's listener and mask the behaviour under test.
function enterEvent(x = 100, y = 100): MouseEvent {
  return new MouseEvent('mouseenter', { clientX: x, clientY: y, bubbles: false });
}

function getTooltipEl(): HTMLElement | null {
  return document.body.querySelector('.vsg-tooltip');
}

describe('tooltip action', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, writable: true, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('does nothing on hover when text is undefined', () => {
    const node = makeNode();
    tooltip(node, undefined);
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(1000);
    expect(getTooltipEl()).toBeNull();
  });

  it('creates a tooltip element after the 500ms delay on mouseenter', () => {
    const node = makeNode();
    tooltip(node, 'hello');
    node.dispatchEvent(mouseEvent('mouseenter'));
    expect(getTooltipEl()).toBeNull(); // not yet
    vi.advanceTimersByTime(500);
    const el = getTooltipEl();
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('hello');
  });

  it('mouseleave hides the tooltip', () => {
    const node = makeNode();
    tooltip(node, 'x');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).not.toBeNull();
    node.dispatchEvent(mouseEvent('mouseleave'));
    expect(getTooltipEl()).toBeNull();
  });

  it('mouseleave before the delay cancels the pending tooltip', () => {
    const node = makeNode();
    tooltip(node, 'x');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(200);
    node.dispatchEvent(mouseEvent('mouseleave'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).toBeNull();
  });

  it('mousemove repositions the tooltip', () => {
    const node = makeNode();
    tooltip(node, 'pos');
    node.dispatchEvent(mouseEvent('mouseenter', 50, 50));
    vi.advanceTimersByTime(500);
    const el = getTooltipEl()!;
    const left1 = el.style.left;
    node.dispatchEvent(mouseEvent('mousemove', 300, 300));
    expect(el.style.left).not.toBe(left1);
  });

  it('update() changes the visible text', () => {
    const node = makeNode();
    const action = tooltip(node, 'first');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()!.textContent).toBe('first');
    action.update('second');
    expect(getTooltipEl()!.textContent).toBe('second');
  });

  it('update() while not visible just stores the text for next hover', () => {
    const node = makeNode();
    const action = tooltip(node, 'first');
    action.update('second');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()!.textContent).toBe('second');
  });

  it('update(undefined) makes future hovers no-op', () => {
    const node = makeNode();
    const action = tooltip(node, 'first');
    action.update(undefined);
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).toBeNull();
  });

  it('Escape keydown hides the visible tooltip', () => {
    const node = makeNode();
    tooltip(node, 'x');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(getTooltipEl()).toBeNull();
  });

  it('non-Escape keys do not hide the tooltip', () => {
    const node = makeNode();
    tooltip(node, 'x');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(getTooltipEl()).not.toBeNull();
  });

  it('window blur hides the tooltip', () => {
    const node = makeNode();
    tooltip(node, 'x');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    window.dispatchEvent(new Event('blur'));
    expect(getTooltipEl()).toBeNull();
  });

  it('dragstart hides the tooltip (native drag suppresses mouseleave)', () => {
    const node = makeNode();
    tooltip(node, 'x');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).not.toBeNull();
    // A native HTML5 drag starting on the node does not fire mouseleave,
    // so the tooltip must be dismissed by the drag itself.
    node.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(getTooltipEl()).toBeNull();
  });

  it('hides when the node becomes disabled (mutation observer)', async () => {
    const node = makeNode();
    tooltip(node, 'x');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).not.toBeNull();
    node.disabled = true;
    // MutationObserver fires asynchronously as a microtask
    await Promise.resolve();
    expect(getTooltipEl()).toBeNull();
  });

  it('destroy() removes tooltip and unbinds listeners', () => {
    const node = makeNode();
    const action = tooltip(node, 'x');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).not.toBeNull();
    action.destroy();
    expect(getTooltipEl()).toBeNull();
    // Further events on the node do not bring it back
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).toBeNull();
  });

  it('suppressTooltips hides an already-visible tooltip', () => {
    const node = makeNode();
    tooltip(node, 'x');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).not.toBeNull();
    const release = suppressTooltips();
    expect(getTooltipEl()).toBeNull();
    release();
  });

  it('while suppressed a new hover does not create a tooltip', () => {
    const node = makeNode();
    tooltip(node, 'x');
    const release = suppressTooltips();
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).toBeNull();
    release();
  });

  it('a tooltip whose timer was pending before suppression does not appear', () => {
    const node = makeNode();
    tooltip(node, 'x');
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(200); // timer pending, not yet fired
    const release = suppressTooltips();
    vi.advanceTimersByTime(500); // timer fires while suppressed
    expect(getTooltipEl()).toBeNull();
    release();
  });

  it('releasing suppression allows tooltips again', () => {
    const node = makeNode();
    tooltip(node, 'x');
    const release = suppressTooltips();
    release();
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).not.toBeNull();
  });

  it('suppression is ref-counted: all releases needed before tooltips resume', () => {
    const node = makeNode();
    tooltip(node, 'x');
    const releaseA = suppressTooltips();
    const releaseB = suppressTooltips();
    releaseA();
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).toBeNull(); // still suppressed by B
    node.dispatchEvent(mouseEvent('mouseleave'));
    releaseB();
    node.dispatchEvent(mouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()).not.toBeNull();
  });

  it('entering a nested tooltip element dismisses the ancestor tooltip (no overlap)', () => {
    // Mirrors the commit subject: a span with a tooltip wrapping a link that
    // also has one. Hovering the link must not leave both tooltips on screen.
    const parent = document.createElement('span');
    const child = document.createElement('a');
    parent.appendChild(child);
    document.body.appendChild(parent);
    tooltip(parent, 'full commit subject');
    tooltip(child, 'open link');

    // Hover the parent first, let its tooltip show.
    parent.dispatchEvent(enterEvent());
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()!.textContent).toBe('full commit subject');

    // Move into the child (ancestor gets no mouseleave). Its tooltip must replace
    // the parent's, never coexist with it.
    child.dispatchEvent(enterEvent());
    vi.advanceTimersByTime(500);
    const tips = document.body.querySelectorAll('.vsg-tooltip');
    expect(tips.length).toBe(1);
    expect(tips[0].textContent).toBe('open link');
  });

  it('a nested hover cancels the ancestor pending timer so it never appears', () => {
    const parent = document.createElement('span');
    const child = document.createElement('a');
    parent.appendChild(child);
    document.body.appendChild(parent);
    tooltip(parent, 'parent');
    tooltip(child, 'child');

    // Parent timer pending (not yet fired), then quickly move into the child.
    parent.dispatchEvent(enterEvent());
    vi.advanceTimersByTime(200);
    child.dispatchEvent(enterEvent());
    vi.advanceTimersByTime(500);
    const tips = document.body.querySelectorAll('.vsg-tooltip');
    expect(tips.length).toBe(1);
    expect(tips[0].textContent).toBe('child');
  });

  it('re-arms a fallback preempted by a nested tooltip once the pointer moves off it', () => {
    // Mirrors the grafted row: the commit subject's tooltip preempts the row's
    // "Grafted" fallback; moving from the subject onto the row (no nested
    // tooltip) must bring the fallback back without re-entering the row.
    const parent = document.createElement('span');
    const child = document.createElement('a');
    parent.appendChild(child);
    document.body.appendChild(parent);
    tooltip(parent, 'Grafted');
    tooltip(child, 'full commit subject');

    parent.dispatchEvent(enterEvent());
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()!.textContent).toBe('Grafted');

    // Move into the child: it preempts the parent's fallback.
    child.dispatchEvent(enterEvent());
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()!.textContent).toBe('full commit subject');

    // Leave the child and move the pointer onto the parent where the child is
    // not — elementFromPoint reports the parent, so the fallback re-arms.
    const spy = vi.spyOn(document, 'elementFromPoint').mockReturnValue(parent);
    child.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    expect(getTooltipEl()).toBeNull();
    parent.dispatchEvent(mouseEvent('mousemove', 100, 100));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()!.textContent).toBe('Grafted');
    spy.mockRestore();
  });

  it('does not re-arm the fallback while a nested tooltip is still under the pointer', () => {
    const parent = document.createElement('span');
    const child = document.createElement('a');
    parent.appendChild(child);
    document.body.appendChild(parent);
    tooltip(parent, 'Grafted');
    tooltip(child, 'subject');

    parent.dispatchEvent(enterEvent());
    vi.advanceTimersByTime(500);
    child.dispatchEvent(enterEvent());
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()!.textContent).toBe('subject');

    // Pointer still over the child → the fallback must stay silent.
    const spy = vi.spyOn(document, 'elementFromPoint').mockReturnValue(child);
    parent.dispatchEvent(mouseEvent('mousemove', 100, 100));
    vi.advanceTimersByTime(500);
    expect(getTooltipEl()!.textContent).toBe('subject');
    spy.mockRestore();
  });

  it('hovering near the viewport edge flips position to the other side', () => {
    const node = makeNode();
    tooltip(node, 'flip me to the left');
    // Mouse near right/bottom edge — element overflow should trigger flip.
    node.dispatchEvent(mouseEvent('mouseenter', 1020, 760));
    vi.advanceTimersByTime(500);
    const el = getTooltipEl()!;
    // Should sit at clamped/flipped coords, not at mouseX + 8 / mouseY + 14.
    expect(parseFloat(el.style.left)).toBeLessThan(1020);
    expect(parseFloat(el.style.top)).toBeLessThan(760);
  });
});
