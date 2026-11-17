# @kerneldreams/backend-http

## main
serveBackend(backend: ProtocolBackend, opts?: ServeBackendOpts): Promise<ServeHandle>
> Поднимает HTTP-сервер над бэкендом (§9).

```ts
const srv = await serveBackend(backend, { port: 7331 })
const client = createHttpBackend(srv.url)
```
ServeBackendOpts { port?, host?, cors?, basePath?, maxBodyBytes? }
ServeHandle { server, url, port, close }
createHttpBackend(url: string, opts?: HttpBackendOpts): ProtocolBackend
> ProtocolBackend поверх HTTP-биндинга §9.

```ts
const backend = createHttpBackend('http://127.0.0.1:7331')
for await (const ev of backend.run(sid, { userMessage: 'привет' })) ...
```

Опциональные методы (fork, messages.*, catalog, ...) присутствуют всегда:
capabilities асинхронны, а фабрика синхронна — узнать их к моменту сборки
объекта нельзя. Правило «метод есть ⇔ capability заявлена» держит бэкенд за
проводом: незаявленная операция приезжает NotSupportedError. UI и так гасит
фичи по capabilities() (§1.2), а не по наличию метода.
BackendError {  }
> Ошибка бэкенда, доехавшая через Envelope (§4).
HttpBackendOpts { fetch?, headers?, capabilitiesTtl? }
CODE_BAD_REQUEST: "bad_request"
CODE_BUSY: "busy"
CODE_CONNECTION_LOST: "connection_lost"
CODE_NOT_FOUND: "not_found"
CODE_NOT_SUPPORTED: "not_supported"
normalizeBasePath(basePath?: string | undefined): string
> Нормализует basePath: '' | '/api' | 'api/' → '' | '/api'.
Пустая строка = биндинг в корень.
WireEnvelope<T> { code? }