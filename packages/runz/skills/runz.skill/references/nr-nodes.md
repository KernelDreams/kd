# nr-nodes — `@kerneldreams/nodes`

Нодовый редактор: ядро без UI (`/core`) и React-редактор (`/ui`, React 18–19). Зависимостей,
кроме peer `react`, нет. Нужен граф из нод с портами и связями — бери его, не пиши свой
канвас, раскладку или undo. Исходник — `kd/packages/nodes`, живое демо — `npm run demo`
(:5190), полный пример потребителя — `demo/App.tsx`.

```ts
import { NodeRegistry, layoutLayered, applyLayout } from '@kerneldreams/nodes/core'
import { Canvas, useGraph, useSelection, InspectorShell, Toolbar } from '@kerneldreams/nodes/ui'
import '@kerneldreams/nodes/ui/styles'          // классы nn-*
```

## core — данные и операции

| Что | Сигнатура / форма | Заметки |
|---|---|---|
| Прототип ноды | `NodeDef { type, displayName, icon?, color?, category?, description?, ports, dynamicPorts?(data), defaultData?, bodyComponent?, inspectorComponent? }` | `dynamicPorts` добавляется к статическим, зовётся на каждое изменение `data` |
| Порт | `PortDef { id, name, direction: 'in'\|'out', type?, multiple?, default? }` | `type` `'any'`/пусто совместим со всем; несовпадение типов — **valid с message** (не ошибка) |
| Граф | `NodeGraph { version, name, nodes, connections, groups?, meta? }` | нода `{ id, type, name?, position, data }`, связь `{ id, from:{node,port}, to:{node,port} }` |
| Группа | `GraphGroup { id, name, nodes: string[], color? }` | нода — не более чем в одной группе |
| Реестр | `new NodeRegistry()`: `register`, `get`, `getAll`, `getByCategory`, `getCategories`, `createNode(type, position)` | `createNode` копирует `defaultData`, бросает на неизвестном типе |
| Ноды | `addNode(g, node) → [g, id]`, `removeNode` (со связями и членством), `updateNode`, `updateNodeData` (merge), `moveNode`, `moveNodes(g, ids, delta)` | всё иммутабельно |
| Связи | `addConnection(g, from, to, registry) → [g, id \| null]`, `removeConnection`, `getConnections(g, node, dir?)`, `getPortConnections` | `null` — невалидно или дубль; в не-`multiple` вход старая связь заменяется |
| Группы | `addGroup(g, {name, nodes?, color?}) → [g, id]`, `removeGroup` (ноды остаются), `updateGroup(g, id, patch)`, `setNodeGroup(g, node, groupId \| null)`, `getNodeGroup` | перенос из прежней группы — автоматически |
| Порядок | `topologicalSort(g) → string[] \| null` | `null` на цикле |
| Валидация | `validateConnection`, `getNodePorts`, `findPort` | сам на себя нельзя; from — out, to — in |
| JSON | `serializeGraph`, `deserializeGraph`, `generateId()` | `groups` проходят как есть; граф 0.1.x без `groups` валиден |
| Раскладка | `layoutLayered(g, opts?) → Record<id, Position>`, `applyLayout(g, positions)`, `DEFAULT_NODE_SIZE` | ниже |

## Раскладка

`layoutLayered(graph, { direction?: 'LR'|'TB', nodeSize?, gapX? = 80, gapY? = 40 })` — своя
послойная, чистая, детерминированная, не бросает. Слои — длиннейший путь от источников
(ребро, замыкающее цикл, игнорируется; нода без связей — слой 0); порядок в слое —
барицентр соседей (проход вниз и вверх, равенство — порядок `graph.nodes`); члены одной
группы в слое стоят подряд (порядок групп из `graph.groups`, ноды без группы — после).
Начало `{0,0}`, слой сдвигается на ширину самой широкой ноды предыдущего + `gapX`. Размер
ноды по умолчанию 220×120 — для точной раскладки передай `nodeSize` из
`CanvasHandle.getNodeSize(id)`.

Граф из данных без координат (пайплайн): `applyLayout(g, layoutLayered(g))` до первого
рендера, затем `canvasRef.current.fitView()` в эффекте.

## ui — редактор

| Что | Главное |
|---|---|
| `useGraph({ registry, initial?, onAutoSave?, autoSaveDebounce? })` | `graph` + все операции ядра (ноды, связи, группы), `applyLayout(opts?)`, `setGraph`, `clearGraph`, `undo`/`redo`/`canUndo`/`canRedo` (стек 50), `toJSON`/`fromJSON`. Каждая операция — шаг undo; `moveNode` — **без** шага: перед перетаскиванием `beginMove()` (вешается на `onNodeMoveStart`) |
| `useSelection()` | `selectedNodes`, `selectedConnections`, `selectNode(id, multi?)`, `selectNodes(ids)`, `selectConnection`, `deselectAll`, `deleteSelected(graph) → graph` |
| `<Canvas ref>` | пропсы: `graph`, `registry`, `selectedNodes`, `selectedConnections`, `onNodeSelect(ids)`, `onNodeMove`, `onNodeMoveStart/End(ids)`, `onNodeDelete`, `onConnectionCreate/Delete/Select`, `onCanvasClick`, `onUndo`/`onRedo`, `renderNodeBody`, `renderNodePreview`, `initialView`, `readonly`. `ref`: `{ fitView(), getView(), getNodeSize(id) }` |
| `<InspectorShell>` | имя ноды, `inspectorComponent` прототипа (иначе JSON `data`), удаление, ID/тип/позиция |
| `<Toolbar>` | палитра по реестру (по категориям), имя графа, Save/Load/Clear, `onAutoLayout` → кнопка, слот `extra` |
| Мелкие | `NodeView`, `PortView`, `ConnectionView` (безье), `ConnectionPreview`, `NodeErrorBoundary` |

Жесты канваса: пан — средняя кнопка или пробел + левая; зум колесом к курсору (25–200%);
протяжка порт→порт, бросок в радиусе 30px; Delete/Backspace — удалить выбранное; Escape —
снять выбор; Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z — `onUndo`/`onRedo`, только когда фокус в канвасе.
Рамка группы: клик по подписи выбирает членов, перетаскивание за подпись двигает всех
(один шаг undo).

## Тема — токены хоста (0.2.1)

Все цвета, шрифты и радиусы `nodes.css` — через переменные `--nn-*`, объявленные одним блоком на
корнях компонентов (`.nn-canvas`, `.nn-inspector`, `.nn-toolbar`); каждая читает токен темы
nrchat `--nr-*` с прежним значением фолбэком: без токенов редактор выглядит как раньше (тёмный),
внутри nrchat или артефакта — как чат.

| `--nr-*` | где |
|---|---|
| `--nr-bg` | холст, утопленные панели |
| `--nr-surface` | нода, инспектор, тулбар |
| `--nr-raised` | шапка ноды, поля, кнопки |
| `--nr-line`, `--nr-line-soft` | рамки, точки сетки |
| `--nr-fg`, `--nr-muted` | текст, приглушённый |
| `--nr-accent` | выделение, связи, подключённые порты |
| `--nr-error` | ошибки, удаление |
| `--nr-font-ui`, `--nr-font-mono`, `--nr-radius` | шрифты, радиус |

Токены ставятся на любого предка (nrchat — на `:root`). Точечно поправить — переопредели нужную
`--nn-*` на корне. Цвет шапки ноды — по-прежнему `NodeDef.color`. Вне блока переменных литералов
цвета нет (тест `src/ui/__tests__/styles.test.ts`). Демо: кнопка `Theme:` в тулбаре.

## Минимальный потребитель

```tsx
const registry = new NodeRegistry()
registry.register({ type: 'step', displayName: 'Step', ports: [
  { id: 'in', name: 'in', direction: 'in', multiple: true },
  { id: 'out', name: 'out', direction: 'out' },
] })

function Editor() {
  const g = useGraph({ registry })
  const sel = useSelection()
  return <Canvas graph={g.graph} registry={registry}
    selectedNodes={sel.selectedNodes} selectedConnections={sel.selectedConnections}
    onNodeSelect={sel.selectNodes} onNodeMove={g.moveNode} onNodeMoveStart={g.beginMove}
    onNodeDelete={ids => ids.forEach(g.removeNode)}
    onConnectionCreate={(f, t) => g.addConnection(f, t)}
    onConnectionSelect={sel.selectConnection} onCanvasClick={sel.deselectAll}
    onUndo={g.undo} onRedo={g.redo} />
}
```

## Грабли

- Удаление пачки одним шагом undo — `setGraph(ids.reduce(removeNode, graph))`, а не
  `ids.forEach(removeNode)` (тот даёт шаг на каждую ноду).
- Позиции портов меряются в DOM; до первого рендера связи рисуются по константам CSS
  (ширина 160). Переопределяешь размеры `.nn-node` — порты всё равно встанут верно.
- Delete/Backspace и пробел слушаются на `window` (кроме фокуса в input/textarea/select) —
  два канваса на странице удалят выбранное в обоих.
