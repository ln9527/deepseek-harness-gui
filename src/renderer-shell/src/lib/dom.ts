/** 极小 DOM 构造帮助(动态值一律走 textValue,不走 innerHTML 拼接)。 */

export type Attrs = Readonly<Record<string, string | boolean>>

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: readonly (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === true) {
      node.setAttribute(key, '')
    } else if (value !== false) {
      node.setAttribute(key, value)
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) {
      continue
    }
    node.append(child instanceof Node ? child : document.createTextNode(child))
  }
  return node
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild)
  }
}

export function button(label: string, onClick: () => void, opts: { readonly primary?: boolean; readonly disabled?: boolean } = {}): HTMLButtonElement {
  const btn = el('button', { class: opts.primary === true ? 'btn primary' : 'btn' }, label) as HTMLButtonElement
  btn.disabled = opts.disabled === true
  btn.addEventListener('click', () => {
    onClick()
  })
  return btn
}
