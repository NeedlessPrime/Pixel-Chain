/** Tiny hyperscript helper: enough to build the HUD without a framework. */

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'style') {
        if (typeof value === 'string') el.style.cssText = value;
        else Object.assign(el.style, value);
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in el && typeof value !== 'string') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  add(el, ...children);
  return el;
}

/** Append children, skipping null/false (unlike Element.append, which would print "null"). */
export function add(el: Element, ...children: (Child | Child[])[]): void {
  for (const child of children) {
    if (Array.isArray(child)) add(el, ...child);
    else if (child instanceof Node) el.appendChild(child);
    else if (child !== null && child !== undefined && child !== false) el.appendChild(document.createTextNode(String(child)));
  }
}

/** Replace all children. */
export function setChildren(el: Element, ...children: (Child | Child[])[]): void {
  el.replaceChildren();
  add(el, ...children);
}

/** Set text only when it changed (countdowns re-render 4×/s). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
}

/** True when keyboard shortcuts must not fire (typing in a field). */
export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
