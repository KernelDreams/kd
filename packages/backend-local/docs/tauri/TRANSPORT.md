# Транспорт Tauri — норматив

Третий транспорт `nr-ui-protocol` после HTTP (`backend-http`) и in-process (exz-v2-spec §2).
Семантика операций и стрима — канон протокола и backends-spec; здесь только провод.

```
webview                        оболочка (Rust)                    sidecar (Node)
createTauriBackend ──invoke protocol_call {method,args}──▶ пересылка ──▶ createProtocolHost(backend).call
                  ◀────────────── WireEnvelope ─────────── пересылка ◀──
                  ◀── event protocol_event (кадр) ──────── emit окну ◀── opts.emit(payload)
```

## 1. Команда `protocol_call`

Вход: `{ method: string, args?: unknown[] }`. `method` — операция `ProtocolBackend` через точку, `args` — позиционные
аргументы метода как в интерфейсе. Ответ — `WireEnvelope`: `{ ok: true, result? }` | `{ ok: false, error, code? }`.

- Ошибка операции — всегда `ok:false` в **ответе**. Reject `invoke` означает только «провод сломан» (sidecar недоступен);
  клиент превращает его в `BackendError{code:'connection_lost'}`.
- Оболочка: `#[tauri::command] async fn protocol_call(method: String, args: serde_json::Value) -> Result<Value, String>` —
  пересылает в sidecar как есть, `Err` — только когда sidecar недоступен.

| method | args | result |
|---|---|---|
| `capabilities` | — | `Capabilities` |
| `sessions.list` / `.create` / `.get` / `.delete` | — / `[opts]` / `[id]` / `[id]` | `SessionInfo[]` / `SessionInfo` / `SessionInfo` / — |
| `sessions.fork` / `.rename` | `[id, atMessageId?]` / `[id, title]` | `SessionInfo` / — |
| `history` | `[id]` | `HistoryPage` |
| `run` | `[id, input, streamId]` | — (события — стримом, §2) |
| `cancel` / `respond` | `[id, runId]` / `[id, askId, answer]` | — |
| `messages.append` / `.edit` / `.delete` / `.hide` / `.swipe` | `[sid, parts, opts?]` / `[sid, mid, patch]` / `[sid, mid]` / `[sid, mid, hidden]` / `[sid, mid, to]` | `Message` / `Message` / — / — / `Message` |
| `models.list` / `.set` | — / `[sid, model]` | `ModelInfo[]` / `SessionModel` |
| `workspace.current` / `.list` / `.switch` | — / — / `[id]` | `WorkspaceInfo` / `WorkspaceInfo[]` / `WorkspaceInfo` |
| `workspace.files.list` / `.read` / `.stat` | `[path?]` / `[path, opts?]` / `[path]` | `FileEntry[]` / `FileContent` / `FileEntry` |
| `workspace.files.write` / `.delete` / `.rename` | `[path, content, opts?]` / `[path]` / `[from, to]` | `{revision}` / — / — |
| `workspace.files.watch` | `[streamId]` | — (события — стримом, §3) |
| `profiles.list` / `.set` / `.get` / `.save` / `.delete` / `.duplicate` | — / `[sid, id \| doc]` / `[id]` / `[doc]` / `[id]` / `[id, newId]` | как в `ProfilesOps` |
| `catalogs.tools` / `.skills` / `.extensions` | — | каталоги |
| `catalog.bots` / `.bot` / `.asset` | — / `[id]` / `[botId, file]` | `unknown[]` / `unknown` / `{data: base64, mime?}` |
| `personas.list` / `.save` | `[sid]` / `[sid, personas, userId?]` | `PersonasDoc` (v1.9) |
| `meta.get` / `.patch` | `[id]` / `[id, patch]` | `SessionMetaDoc` |
| `attachments.put` | `[sid, name, base64, mime?]` | `AttachmentPutResult` |
| `services.call` | `[plugin, method, args?]` | результат сервиса (v1.11) |
| `services.stream` | `[plugin, method, args?, streamId]` | — (кадры `ServiceEvent`, §3b) |
| `stream.close` | `[streamId]` | — |

**JSON.** IPC Tauri — JSON: `undefined` в позиционном аргументе приезжает `null` и хостом читается как «нет»;
`null` внутри объекта сохраняется (`write(…, {revision: null})` — «создать»). Байты — только base64 и только в двух
местах: `attachments.put` (аргумент) и `catalog.asset` (результат).

**Проверка входа.** Хост проверяет аргументы до бэкенда (webview — граница доверия), как `serveBackend`:
неизвестная операция — `not_found`, битые аргументы — `bad_request`, незаявленная у бэкенда — `not_supported`.

## 2. Стримы: событие `protocol_event`

Кадры: `{stream, type:'event', event}` | `{stream, type:'end'}` | `{type:'reset'}`.

Id стрима выдаёт **клиент** и подписывается на кадры **до** вызова: ответ `invoke` и кадры идут разными каналами,
их взаимный порядок не гарантирован — клиент буферизует.

**run.** Хост отвечает на `run` после первого события итератора:
- авария до первого события (включая `NotSupportedError`, `busy`) — ошибка **вызова**, стрима нет;
- после — события кадрами, авария — синтетический `run_end{status:'error', error:{message, code?}, version:''}`, затем `end`;
- `end` без `run_end` перед ним — клиент отдаёт `run_end{code:'connection_lost'}` (§3.2 backends-spec);
- один активный run на сессию: второй — `busy` до бэкенда;
- клиент ушёл посреди стрима (`break`) — шлёт `stream.close`; ран **не** отменяется (§5.4), хост дочитывает итератор
  молча. Отмена — только `cancel`.

## 3. watch

`workspace.files.watch [streamId]` подписывает хост на `files.watch`; `workspace_update` едут кадрами `event`;
`stream.close` отписывает. Потеря канала (`end`, `reset`, упавший вызов) — клиент переподписывается с backoff
(500 мс → 30 с) и после любой подписки, кроме первой, отдаёт подписчику `paths: ['']` — «перечитай всё».
`not_supported` / `bad_request` / `not_found` — канала нет и не будет, без ретраев.

## 3b. services.stream (протокол v1.11)

`services.stream [plugin, method, args?, streamId]`: незаявленный стрим (гейт по capability хоста, не по первому
кадру — стрим вправе молчать) — ошибка **вызова** `not_supported`. Иначе ответ сразу, дальше кадры `event` с
`ServiceEvent {name, payload?}`; throw сервиса — кадр `{name:'error', payload:{message, code?}}`, затем `end`.
`stream.close` — `return()` итератора: сервису abort. `host.close()` — кадр `error {code:'connection_lost'}`, затем
`end`; `reset` — клиент сам отдаёт тот же кадр. Клиентский `return()` шлёт `stream.close` сразу, не дожидаясь кадра.
`args` — JSON: `undefined` и `null` хост читает как «нет аргумента».

## 4. reset и закрытие

- `{type:'reset'}` шлёт **оболочка**, когда sidecar умер или перезапущен: все стримы клиента оборваны
  (раны — `connection_lost`, watch — переподписка).
- `host.close()` — каждому стриму `end`, watch'и отписаны, дальнейшие вызовы — `ok:false`. `backend.close()` не зовётся:
  жизнь бэкенда — у того, кто его собрал.
- `client.close()` — `stream.close` на все свои стримы, свои раны — `connection_lost`, новые вызовы бросают.

## 5. Ошибки

| code | когда | на клиенте |
|---|---|---|
| `not_supported` | операция не заявлена | `NotSupportedError` |
| `bad_request` / `not_found` / `busy` / `conflict` / любой строковый `err.code` бэкенда | как у HTTP | `BackendError{code}` |
| — (нет кода) | прочая ошибка бэкенда | `BackendError` без `code` |
| `connection_lost` | reject `invoke`, `reset`, `end` без `run_end` | `BackendError` / синтетический `run_end` |

HTTP-статусов нет; `basePath`, CORS и авторизации нет — провод локален окну.

## 6. Sidecar ⇄ оболочка (рекомендация, не норматив пакета)

Пакет не знает, как Rust разговаривает с Node. Проще всего NDJSON по stdio: `{id, method, args}` → `{id, reply}`
на вызов и `{event: payload}` на кадр; оболочка сопоставляет `id` с ожидающей командой, кадры — `app.emit('protocol_event', payload)`
в окно sidecar'а, при выходе процесса — `{type:'reset'}`.
