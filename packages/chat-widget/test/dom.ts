// DOM для юнитов: окно jsdom, глобально — только то, что нужно виджету.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html lang="ru"><body></body></html>', { pretendToBeVisual: true })
const w = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'HTMLElement', 'HTMLDetailsElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'customElements', 'CustomEvent', 'KeyboardEvent', 'Node', 'Element', 'ShadowRoot']) {
  ;(globalThis as Record<string, unknown>)[key] = key === 'window' ? dom.window : w[key]
}
