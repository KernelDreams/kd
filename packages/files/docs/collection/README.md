# @kerneldreams/files/collection

Модель панели записей (`nrchat.dev/specs/objects-spec.md` §4.1): общая часть любого источника
панели — файлов (`@kerneldreams/files`), персон, сессий. Zero-dep, без DOM: один код у
плагина nrchat `collection`, дистрибутива `far` и страниц без React.

| модуль | что |
|---|---|
| `item` | запись `Item {name, path, kind: 'file' \| 'dir', size?, mtime?}` (`dir` — группа), `isHidden` |
| `mask` | маски Far `compileMask('*.png;*.jpg\|tmp*')`, быстрый поиск `quickFind` |
| `sort` | `sortItems(items, {key, desc}, compare)` — группы сверху, ключи и сравнения — у источника; `ITEM_COMPARE` (имя, размер, время), `compareText` |
| `format` | `formatSize`, `formatTime` (колонки Far) |
| `state` | состояние списка `{view, sort, cursor, selection, columns, hidden, tile}` ⇄ параметры вкладки по форме источника (`ListShape`): `defaultList`, `encodeList`, `decodeList`, `nextOf`, `clampTile` |
| `selection` | выделение Far: `toggle`, `selectRange` (Shift), `selectByMask` (Gray±), `invert` (Gray*), `prune`, `operands` |
| `tree` | строки дерева `buildTreeRows(root, groups, expanded, {order, hidden, filter})`, `dirsToReload` |
| `decorations` | пометки: `DecorationProvider`, `collectDecorations` |

```
npm install && npm run build && npm test
```
