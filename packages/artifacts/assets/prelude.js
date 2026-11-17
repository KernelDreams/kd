/**
 * Мост артефакта v2 — гостевая сторона (artifacts-spec §4). Наследник prelude
 * exz v1 (клиент exz 1.2.0): весь v1-API без изменений сигнатур,
 * провод `{__exz: …}` через postMessage к родительскому окну — тот же.
 *
 *   гость → хост   {__exz:'req', id, method, args}     ответ {__exz:'res', id, result}
 *   хост → гость   {__exz:'watch', cbId}                изменение по watch
 *   гость → хост   {__exz:'unwatch', watchId}
 *   гость → хост   {__exz:'svc-on', subId, event} / {__exz:'svc-off', subId}
 *   хост → гость   {__exz:'svc-ev', subId, payload}
 *   хост → гость   {__exz:'host-ev', event, payload}    theme, reload, …
 *   гость → хост   {__exz:'hello'}                      страница готова: пришли тему
 *   гость → хост   {__exz:'error', error}              ошибка рантайма (onerror, unhandledrejection,
 *                                                       не загрузился <script>/<link>) — п.2
 *   гость → хост   {__exz:'loaded'}                     window 'load': от него хост меряет окно проверки
 *   хост → гость   {__exz:'host-ev', event:'comfy', payload}  событие генерации `comfy.queue`;
 *                                                       канал фронт открывает на первом вызове comfy.*
 *   хост → гость   {__exz:'host-ev', event:'image', payload}  событие генерации `image.generate`;
 *                                                       канал фронт открывает на первом вызове image.*
 *   гость → хост   req 'viewer.open' [images, index]   смотрелка оболочки поверх окна
 *   гость → хост   req 'speak.say' [text, opts] / 'speak.transcribe' [bytes, opts] / 'llm.complete' [arg]  голос и модель стенда
 *   хост → гость   {__exz:'host-ev', event:'file', payload:{file, dir, kinds}}  файл окна сменился (вкладка
 *                                                       файла, `$handles`, open-spec §7); `getContext()` уже новый
 *   гость → хост   req 'session.*'                       данные сессии чата: meta/personas/history/tools
 *   хост → гость   {__exz:'host-ev', event:'session', payload:{meta, hash, personas, sessionId, title}}
 *                                                       мета или персоны сменились (кем угодно); шлётся после
 *                                                       первого session.meta.on
 *   гость → хост   req 'skins.*'                         редактор тем: list/get/contract/check/save
 *                                                       — хост; preview/apply — фронт (тема у клиента)
 *   гость → хост   req 'job.*'                           задачи: start/list/get/cancel — вызовом;
 *                                                       job.attach [id, cbId, from] → ответ {ok, value: attachId}
 *   хост → гость   {__exz:'job', cbId, frame}           кадр лога задачи (до конца задачи)
 *   гость → хост   {__exz:'job-off', attachId}          отписка от лога
 *   хост → гость   {__exz:'host-ev', event:'tool', payload:{callId, name, args}}  модель зовёт тул артефакта
 *   гость → хост   {__exz:'tool-res', callId, result}   ответ тула: строка | {text, data?, error?}
 *   хост → гость   {__exz:'host-ev', event:'widget', payload:{value, props, path, readOnly, theme}}
 *                                                       артефакт — виджет поля редактора (`$widget`)
 *   гость → хост   req 'widget.change' [value] | 'widget.size' [height]   правка поля (команда object.set) / высота
 *   гость → хост   req 'preview.show' [src] | 'preview.clear' []  живой предпросмотр поверх оригинала:
 *                                                       src — data:/https URL, <canvas> или {bytes, mime}; рисует
 *                                                       владелец сцены (смотрелка) над файлом окна; исполняет фронт
 *
 * Адреса страницы — относительные (страница живёт и на своём origin, и за
 * бэкендом `/services/artifacts/http/…`), origin для `fileUrl` — из `location`.
 * `localStorage`/`sessionStorage` гостя — под префиксом id артефакта: у всех
 * артефактов один origin (и через бэкенд — origin самого nrchat), без префикса
 * они видели бы ключи друг друга.
 *
 * Каждый асинхронный метод резолвится Result `{ok, value|error}` и не бросает.
 * Чистый JS без сборки: файл отдаётся гостю как есть.
 */
;(function () {
  if (typeof window === 'undefined' || window.__host) return
  if (window.parent === window) return

  var cfg = window.__NR_ARTIFACT__ || {}
  if (!cfg.origin) {
    var href = String(location.href).split('#')[0].split('?')[0]
    var at = href.lastIndexOf('/a/' + (cfg.key || '') + '/')
    cfg.origin = at >= 0 ? href.slice(0, at) : ''
  }
  var pageBase = cfg.origin + '/a/' + (cfg.key || '') + '/'
  var pending = new Map()
  var watchers = new Map()
  var svcSubs = new Map()
  var hostSubs = new Map()
  var nextId = 1

  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return
    var vars = theme.vars || {}
    var root = document.documentElement
    for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) root.style.setProperty(k, vars[k])
    // Только атрибут: color-scheme — решение гостя (профиль: `color-scheme: light dark`).
    if (theme.mode) root.dataset.theme = theme.mode
    // Веб-шрифты темы: новый скин мог привезти свой — подключить.
    var fonts = Array.isArray(theme.fonts) ? theme.fonts : []
    for (var i = 0; i < fonts.length; i++) {
      var href = fonts[i]
      if (typeof href !== 'string' || !/^https:\/\/[^\s"'<>]+$/.test(href)) continue
      var have = false
      var links = document.querySelectorAll('link[data-nr-font]')
      for (var j = 0; j < links.length; j++) if (links[j].getAttribute('href') === href) have = true
      if (have || !document.head) continue
      var link = document.createElement('link')
      link.rel = 'stylesheet'
      link.setAttribute('data-nr-font', '')
      link.href = href
      document.head.appendChild(link)
    }
    cfg.theme = theme
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return
    var msg = e.data
    if (!msg || typeof msg !== 'object') return
    if (msg.__exz === 'res') {
      var resolve = pending.get(msg.id)
      if (resolve) {
        pending.delete(msg.id)
        resolve(msg.result)
      }
    } else if (msg.__exz === 'watch') {
      var cb = watchers.get(msg.cbId)
      if (cb) cb(msg.event)
    } else if (msg.__exz === 'job') {
      var jcb = jobSubs.get(msg.cbId)
      if (jcb) jcb(msg.frame)
    } else if (msg.__exz === 'app') {
      var acb = appSubs.get(msg.cbId)
      if (acb) acb(msg.event)
    } else if (msg.__exz === 'svc-ev') {
      var scb = svcSubs.get(msg.subId)
      if (scb) scb(msg.payload)
    } else if (msg.__exz === 'host-ev') {
      if (msg.event === 'theme') applyTheme(msg.payload)
      if (msg.event === 'comfy' && msg.payload) onComfy(msg.payload)
      if (msg.event === 'image' && msg.payload) onImage(msg.payload)
      if (msg.event === 'session') onSessionEvent(msg.payload)
      if (msg.event === 'tool') onToolCall(msg.payload)
      if (msg.event === 'widget') onWidget(msg.payload)
      var set = hostSubs.get(msg.event)
      if (set) set.forEach(function (fn) { fn(msg.payload) })
    }
  })

  function post(message) {
    window.parent.postMessage(message, '*')
  }

  // ── ошибки рантайма → хост (агент узнаёт о них из artifact_finalize) ──────
  var reported = 0
  function rel(url) {
    url = String(url || '')
    return url.indexOf(pageBase) === 0 ? url.slice(pageBase.length) : url
  }
  function stackOf(err) {
    var st = err && err.stack ? String(err.stack) : ''
    return st ? st.split(pageBase).join('').split('\n').slice(0, 20).join('\n') : undefined
  }
  function report(e) {
    if (reported++ >= 50) return
    try {
      post({ __exz: 'error', error: e })
    } catch (_) {
      // не клонируется — молчим
    }
  }
  window.addEventListener(
    'error',
    function (ev) {
      var t = ev.target
      // Ресурс: незагрузившийся скрипт/стиль — артефакт мёртв так же, как от исключения.
      if (t && t !== window && t.tagName) {
        var tag = String(t.tagName).toLowerCase()
        if (tag === 'script' || (tag === 'link' && /stylesheet/i.test(t.rel || ''))) {
          var src = t.src || t.href || ''
          report({ kind: 'resource', message: 'не загрузился <' + tag + '> ' + rel(src), source: rel(src) })
        }
        return
      }
      var err = ev.error
      report({
        kind: 'error',
        message: String(ev.message || (err && err.message) || err || 'Script error'),
        source: rel(ev.filename),
        line: ev.lineno || undefined,
        col: ev.colno || undefined,
        stack: stackOf(err),
      })
    },
    true,
  )
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason
    report({
      kind: 'unhandledrejection',
      message: 'Unhandled rejection: ' + String((r && r.message) || r),
      stack: stackOf(r),
    })
  })
  window.addEventListener('load', function () {
    post({ __exz: 'loaded' })
  })

  // ── localStorage/sessionStorage: пространство имён артефакта ─────────────
  function scopedStorage(name) {
    var real = null
    try {
      real = window[name]
      real.getItem('')
    } catch (_) {
      real = null
    }
    var prefix = 'nr-artifact:' + (cfg.id || cfg.key || '') + ':'
    var mem = Object.create(null)
    function keys() {
      var out = []
      if (!real) return Object.keys(mem)
      for (var i = 0; i < real.length; i++) {
        var k = real.key(i)
        if (k && k.indexOf(prefix) === 0) out.push(k.slice(prefix.length))
      }
      return out
    }
    var api = {
      getItem: function (k) {
        k = String(k)
        if (real) return real.getItem(prefix + k)
        return k in mem ? mem[k] : null
      },
      setItem: function (k, v) {
        k = String(k)
        v = String(v)
        if (real) real.setItem(prefix + k, v)
        else mem[k] = v
      },
      removeItem: function (k) {
        k = String(k)
        if (real) real.removeItem(prefix + k)
        else delete mem[k]
      },
      clear: function () {
        keys().forEach(function (k) { api.removeItem(k) })
      },
      key: function (i) {
        var all = keys()
        return i >= 0 && i < all.length ? all[i] : null
      },
    }
    Object.defineProperty(api, 'length', { get: function () { return keys().length }, configurable: true })
    if (typeof Proxy !== 'function') return api
    return new Proxy(api, {
      get: function (t, p) {
        if (typeof p === 'symbol' || p in t) return t[p]
        return t.getItem(p)
      },
      set: function (t, p, v) {
        if (typeof p === 'symbol' || p in t) return false
        t.setItem(p, v)
        return true
      },
      deleteProperty: function (t, p) {
        if (typeof p !== 'symbol') t.removeItem(p)
        return true
      },
      has: function (t, p) {
        return p in t || (typeof p === 'string' && t.getItem(p) !== null)
      },
      ownKeys: function () {
        return keys()
      },
      getOwnPropertyDescriptor: function (t, p) {
        if (typeof p !== 'string' || p in t) return undefined
        var v = t.getItem(p)
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true }
      },
    })
  }
  ;['localStorage', 'sessionStorage'].forEach(function (name) {
    try {
      var scoped = scopedStorage(name)
      Object.defineProperty(window, name, { get: function () { return scoped }, configurable: true })
    } catch (_) {
      // не переопределяется — гость видит общее хранилище (как до)
    }
  })

  function call(method, args) {
    var id = nextId++
    return new Promise(function (resolve) {
      pending.set(id, resolve)
      post({ __exz: 'req', id: id, method: method, args: args })
    })
  }

  // ── job: задачи — долгий прогон вне окна (jobs-spec §6) ─────────
  // Задача переживает вкладку и рестарт бэкенда; лог — attach с любого места.
  var jobSubs = new Map()
  var job = Object.freeze({
    /** Поставить задачу → Result {ok, value: JobInfo}; opts: {title, keys, files: [{name, text|bytes|path}], now}. */
    start: function (target, values, opts) { return call('job.start', [target, values || {}, opts || null]) },
    /** Задачи (новые первыми) → Result {ok, value: JobView[]}; opts: {target, status, limit}. */
    list: function (opts) { return call('job.list', [opts || null]) },
    get: function (id) { return call('job.get', [id]) },
    cancel: function (id) { return call('job.cancel', [id]) },
    /** Лог: cb(кадр {n, kind: line|start|end|…, stream, text, status}) с начала (opts.from — с номера); → Promise<отписка>. */
    attach: function (id, cb, opts) {
      var cbId = 'j' + nextId++
      jobSubs.set(cbId, cb)
      return call('job.attach', [id, cbId, (opts && opts.from) || 0]).then(function (res) {
        if (!res.ok) {
          jobSubs.delete(cbId)
          throw new Error(res.error)
        }
        var attachId = res.value
        return function () {
          jobSubs.delete(cbId)
          post({ __exz: 'job-off', attachId: attachId })
        }
      })
    },
  })

  // ── app: вид mdz-приложения (mdz-apps-spec §2) ─────────────────
  // run(values, cb) → Promise<Result {ok, value: {runId, status, outputs, error?}}>; cb(событие {name, payload})
  // приходит по ходу запуска: started {runId} → status {text} → output {name, text|path}.
  var appSubs = new Map()
  var app = Object.freeze({
    run: function (values, cb) {
      var cbId = 'a' + nextId++
      if (typeof cb === 'function') appSubs.set(cbId, cb)
      return call('app.run', [values || {}, cbId]).then(function (res) {
        appSubs.delete(cbId)
        return res
      })
    },
    /** Лог дня (YYYY-MM-DD, нет — сегодня) → Result {ok, value: {day, days, runs}}. */
    log: function (day) { return call('app.log', [day || null]) },
    /** «Взять в контекст»: пин запуска (состояние вида, в файл не пишется). */
    pin: function (runId, on) { return call('app.pin', [runId, on !== false]) },
  })

  var runSeq = 0
  function run(target, values) {
    var runId = 'r' + Date.now().toString(36) + '-' + ++runSeq
    var p = call('run', [target, values || {}, runId])
    p.runId = runId
    return p
  }
  run.cancel = function (runId) {
    return call('run.cancel', [runId])
  }

  // ── comfy: генерация ComfyUI через бэкенд ──────────────────────
  // События job приходят в канал 'comfy'; буферизуются по id — подписка после
  // queue() (id известен только из ответа) получает всё с начала.
  var comfyJobs = new Map()
  var comfyAll = new Set()
  var COMFY_END = { execution_success: 'success', execution_error: 'error', execution_interrupted: 'interrupted' }
  function absUrl(p) { return (cfg.origin || '') + p }
  function comfyJob(id) {
    var j = comfyJobs.get(id)
    if (!j) {
      j = { events: [], subs: new Set(), end: null, waiters: [] }
      comfyJobs.set(id, j)
      if (comfyJobs.size > 50) {
        var it = comfyJobs.keys()
        for (var k = it.next(); !k.done && comfyJobs.size > 50; k = it.next()) {
          var old = comfyJobs.get(k.value)
          if (old && old.end) comfyJobs.delete(k.value)
        }
      }
    }
    return j
  }
  function onComfy(e) {
    if (e.path) e.url = absUrl(e.path)
    if (e.images) e.images.forEach(function (i) { if (i.path) i.url = absUrl(i.path) })
    var j = comfyJob(e.id)
    if (e.kind === 'preview') j.events = j.events.filter(function (x) { return x.kind !== 'preview' })
    j.events.push(e)
    if (COMFY_END[e.kind]) {
      j.end = { status: COMFY_END[e.kind], images: e.images || [], error: e.message }
      j.waiters.splice(0).forEach(function (fn) { fn(j.end) })
    }
    j.subs.forEach(function (fn) { fn(e) })
    comfyAll.forEach(function (fn) { fn(e) })
  }
  function comfyOn(id, cb) {
    if (typeof id === 'function') {
      comfyAll.add(id)
      return function () { comfyAll.delete(id) }
    }
    var j = comfyJob(String(id))
    j.events.forEach(function (e) { cb(e) })
    j.subs.add(cb)
    return function () { j.subs.delete(cb) }
  }
  function comfyWait(id) {
    var j = comfyJob(String(id))
    return new Promise(function (resolve) {
      if (j.end) resolve(j.end)
      else j.waiters.push(resolve)
    })
  }
  var comfy = Object.freeze({
    /** PNG (байты) → {prompt?, workflow?}. */
    parse: function (bytes) { return call('comfy.parse', [bytes]) },
    /** Схемы нод сервера; classes — только эти. */
    objectInfo: function (classes) { return call('comfy.objectInfo', [classes || null]) },
    /** Виджет-входы prompt: [{nodeId, nodeTitle, classType, name, type, value, options?, min?, max?, step?, multiline?, seed?}]. */
    inputs: function (prompt) { return call('comfy.inputs', [prompt]) },
    /** Картинка в input/ сервера → {filename, subfolder, type, value}; value — для LoadImage.image. */
    upload: function (bytes, name) { return call('comfy.upload', [bytes, name || 'image.png']) },
    /**
     * Поставить prompt → Result {ok, value: {id, number, done}}; done — Promise итога
     * {status: 'success'|'error'|'interrupted', images, error?}. opts.onEvent — события job
     * (progress, preview {url}, executed {images[{url}]}, …); opts.workflow — UI-граф в PNG.
     */
    queue: function (prompt, opts) {
      opts = opts || {}
      return call('comfy.queue', [prompt, opts.workflow ? { workflow: opts.workflow } : null]).then(function (r) {
        if (r && r.ok && r.value && r.value.id) {
          var id = r.value.id
          if (typeof opts.onEvent === 'function') comfyOn(id, opts.onEvent)
          r.value.done = comfyWait(id)
        }
        return r
      })
    },
    interrupt: function (id) { return call('comfy.interrupt', [id]) },
    /** События: on(cb) — всех job, on(id, cb) — одного (с начала). Возвращает отписку. */
    on: comfyOn,
    /** Итог job: {status, images, error?}. */
    wait: comfyWait,
    /** Картинка сервера ({filename, subfolder, type}) → URL для <img>. */
    view: function (image) {
      if (image && image.url) return image.url
      var q = 'filename=' + encodeURIComponent(image.filename) + '&subfolder=' + encodeURIComponent(image.subfolder || '') + '&type=' + encodeURIComponent(image.type || 'output')
      return absUrl('/c/' + (cfg.key || '') + '/view?' + q)
    },
    /** Сохранить картинку PNG с воркфлоу: путь от {workspace} (или в $fs-write) → {path, bytes}. */
    save: function (image, meta, path) { return call('comfy.save', [image, meta || null, path]) },
  })

  // ── image: генерация любым провайдером контракта ──────────────
  // Ключи и вызовы — у хоста; события генерации — канал 'image', буфер по id
  // (как у comfy). Превью и результаты — пути хоста `/i/<key>/<id>/…` для <img>.
  var imageJobs = new Map()
  var imageAll = new Set()
  var IMAGE_END = { done: 'done', error: 'error', cancelled: 'cancelled' }
  function imageJob(id) {
    var j = imageJobs.get(id)
    if (!j) {
      j = { events: [], subs: new Set(), end: null, waiters: [] }
      imageJobs.set(id, j)
      if (imageJobs.size > 50) {
        var it = imageJobs.keys()
        for (var k = it.next(); !k.done && imageJobs.size > 50; k = it.next()) {
          var old = imageJobs.get(k.value)
          if (old && old.end) imageJobs.delete(k.value)
        }
      }
    }
    return j
  }
  function onImage(e) {
    if (e.path) e.url = absUrl(e.path)
    if (e.images) e.images.forEach(function (i) { if (i.path) i.url = absUrl(i.path) })
    var j = imageJob(e.id)
    if (e.kind === 'preview' || e.kind === 'progress') j.events = j.events.filter(function (x) { return x.kind !== e.kind })
    j.events.push(e)
    if (IMAGE_END[e.kind]) {
      j.end = { status: IMAGE_END[e.kind], images: e.images || [], meta: e.meta || null, secs: e.secs, error: e.message, name: e.name }
      j.waiters.splice(0).forEach(function (fn) { fn(j.end) })
    }
    j.subs.forEach(function (fn) { fn(e) })
    imageAll.forEach(function (fn) { fn(e) })
  }
  function imageOn(id, cb) {
    if (typeof id === 'function') {
      imageAll.add(id)
      return function () { imageAll.delete(id) }
    }
    var j = imageJob(String(id))
    j.events.forEach(function (e) { cb(e) })
    j.subs.add(cb)
    return function () { j.subs.delete(cb) }
  }
  function imageWait(id) {
    var j = imageJob(String(id))
    return new Promise(function (resolve) {
      if (j.end) resolve(j.end)
      else j.waiters.push(resolve)
    })
  }
  var image = Object.freeze({
    /** Провайдеры с картинками: [{name}] — блоки `## $provider` хоста (bfl, nanogpt, comfy). */
    providers: function () { return call('image.providers', []) },
    /** Модели провайдера: [{id, name?, edit?, maxRefs?, price?}]. */
    models: function (provider) { return call('image.models', [provider]) },
    /** Схема модели: {fields: {имя: {type, enum?, min?, max?}}, maxRefs?} | null. */
    schema: function (provider, model) { return call('image.schema', [provider, model]) },
    /**
     * Генерация → Result {ok, value: {id, done}}; done — Promise итога {status: 'done'|'error'|'cancelled',
     * images [{index, mime, url}], meta, secs, error?}. req — {model, prompt?, refs?: Uint8Array[],
     * subjects?: Uint8Array[] (рефы персонажа — Veo), params?};
     * opts.onEvent — события (progress {stage, status, step, total}, preview {url}, done, error, cancelled).
     */
    generate: function (provider, req, opts) {
      req = req || {}
      opts = opts || {}
      var refs = Array.isArray(req.refs) ? req.refs : []
      var body = { model: req.model }
      if (req.prompt !== undefined) body.prompt = req.prompt
      if (req.params) body.params = req.params
      var subjects = Array.isArray(req.subjects) ? req.subjects : []
      return call('image.generate', subjects.length ? [provider, body, refs, subjects] : [provider, body, refs]).then(function (r) {
        if (r && r.ok && r.value && r.value.id) {
          var id = r.value.id
          if (typeof opts.onEvent === 'function') imageOn(id, opts.onEvent)
          r.value.done = imageWait(id)
        }
        return r
      })
    },
    cancel: function (id) { return call('image.cancel', [id]) },
    /** Байты результата n (с 0) → Uint8Array. */
    bytes: function (id, n) { return call('image.bytes', [id, n || 0]) },
    /** Результат на диск: путь от {workspace} (или в $fs-write) → {path, bytes}. */
    save: function (id, n, path) { return call('image.save', [id, n || 0, path]) },
    /** URL результата для <img>. */
    url: function (id, n) { return absUrl('/i/' + (cfg.key || '') + '/' + id + '/' + (n || 0)) },
    on: imageOn,
    wait: imageWait,
  })

  // ── speak / llm: голос и модель стенда одной строкой ──────────
  // say → {bytes, mime}; play — сказать и дождаться конца (строка или массив: синтез всех
  // кусков заказывается сразу, звучат по очереди); stop — замолчать; record → {stop() → {text}}.
  var speakAudio = null
  var speakRun = 0
  function speakPlayBytes(v) {
    return new Promise(function (resolve) {
      if (!speakAudio) speakAudio = new Audio()
      var url = URL.createObjectURL(new Blob([v.bytes], { type: v.mime || 'audio/mpeg' }))
      var done = function (ok) { URL.revokeObjectURL(url); resolve(ok) }
      speakAudio.onended = function () { done(true) }
      speakAudio.onerror = function () { done(false) }
      speakAudio.src = url
      var p = speakAudio.play()
      if (p && p.catch) p.catch(function () { done(false) })
    })
  }
  var speak = Object.freeze({
    /** Синтез → Result {bytes: Uint8Array, mime}; opts {voice?, speed?}. */
    say: function (text, opts) { return call('speak.say', [String(text == null ? '' : text), opts || null]) },
    /**
     * Сказать вслух и дождаться конца → Result {ok, value: {played}}. text — строка или массив;
     * opts {voice?, speed?, onPart(i)}. Новый play/stop прерывает прежний.
     */
    play: function (text, opts) {
      opts = opts || {}
      var parts = (Array.isArray(text) ? text : [text]).map(function (t) { return String(t == null ? '' : t).trim() }).filter(Boolean)
      if (speakAudio) speakAudio.pause()
      var run = ++speakRun
      var jobs = parts.map(function (t) { return call('speak.say', [t, { voice: opts.voice, speed: opts.speed }]) })
      var played = 0
      var step = function (i) {
        if (run !== speakRun) return Promise.resolve({ ok: true, value: { played: played, stopped: true } })
        if (i >= jobs.length) return Promise.resolve({ ok: true, value: { played: played } })
        return jobs[i].then(function (r) {
          if (run !== speakRun) return { ok: true, value: { played: played, stopped: true } }
          if (!r || !r.ok) return r
          if (typeof opts.onPart === 'function') try { opts.onPart(i) } catch (_) {}
          return speakPlayBytes(r.value).then(function () { played++; return step(i + 1) })
        })
      }
      return step(0)
    },
    stop: function () {
      speakRun++
      if (speakAudio) speakAudio.pause()
    },
    voices: function () { return call('speak.voices', []) },
    /** Запись → текст: bytes — Uint8Array звука; opts {mime?, language?, prompt?} → Result {text}. */
    transcribe: function (bytes, opts) { return call('speak.transcribe', [bytes, opts || null]) },
    /** Микрофон → Result {stop() → Result {text}, cancel()}; opts как у transcribe. */
    record: function (opts) {
      opts = opts || {}
      if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') return Promise.resolve({ ok: false, error: 'speak.record: микрофон недоступен' })
      return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var rec = new MediaRecorder(stream)
        var chunks = []
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data) }
        rec.start()
        var finish = function () {
          return new Promise(function (resolve) {
            rec.onstop = function () { stream.getTracks().forEach(function (t) { t.stop() }); resolve() }
            if (rec.state !== 'inactive') rec.stop()
            else rec.onstop()
          })
        }
        return {
          ok: true,
          value: {
            stop: function () {
              return finish().then(function () {
                var mime = rec.mimeType || 'audio/webm'
                return new Blob(chunks, { type: mime }).arrayBuffer().then(function (buf) {
                  return call('speak.transcribe', [new Uint8Array(buf), { mime: mime.split(';')[0], language: opts.language, prompt: opts.prompt }])
                })
              })
            },
            cancel: function () { return finish() },
          },
        }
      }, function (e) { return { ok: false, error: 'speak.record: ' + (e && e.message || e) } })
    },
  })
  var llm = Object.freeze({
    /**
     * Модель стенда → Result {text, model}. arg — строка (вопрос) или
     * {prompt?, system?, messages?: [{role, content}], model?, maxTokens?, temperature?, json?}.
     */
    complete: function (arg) { return call('llm.complete', [arg]) },
    models: function () { return call('llm.models', []) },
  })

  // ── viewer: смотрелка оболочки поверх всего окна ──────────────
  // Картинка — URL (строка), {url, name}, картинка comfy ({filename, subfolder,
  // type} / событие с url) или <img>. Относительное — от страницы: у оболочки
  // другой origin.
  function viewerItem(x) {
    if (x && typeof x === 'object' && typeof x.tagName === 'string') x = { url: x.currentSrc || x.src, name: x.alt || undefined }
    else if (x && typeof x === 'object' && !x.url && x.filename) x = { url: comfy.view(x), name: x.filename }
    else if (typeof x === 'string') x = { url: x }
    if (!x || typeof x.url !== 'string') return x
    var url = x.url
    try {
      url = new URL(url, location.href).href
    } catch (_) {
      // не URL — отказ придёт от хоста
    }
    return x.name ? { url: url, name: String(x.name) } : { url: url }
  }
  // ── preview: живой предпросмотр поверх оригинала ─────────────
  // Картинка над файлом окна — слоем сцены смотрелки, пока гость не скажет clear (или вкладка не закроется).
  function previewSrc(x) {
    if (x && typeof x === 'object' && typeof x.toDataURL === 'function') return { url: x.toDataURL('image/png') }
    if (typeof x === 'string') return { url: x }
    if (x && typeof x === 'object' && x.bytes) return { bytes: x.bytes, mime: typeof x.mime === 'string' ? x.mime : 'image/png' }
    return x
  }
  var preview = Object.freeze({
    show: function (src) { return call('preview.show', [previewSrc(src)]) },
    clear: function () { return call('preview.clear', []) },
  })

  var viewer = Object.freeze({
    /** Показать картинки смотрелкой оболочки (зум, панорама, ← →, Esc); index — с какой начать. */
    open: function (images, index) {
      var list = Array.isArray(images) ? images : [images]
      return call('viewer.open', [list.map(viewerItem), typeof index === 'number' ? index : 0])
    },
  })

  // ── session: данные сессии чата ────────────────────────────
  // Исполняет фронт (ctx.session во вкладке nrchat, бэкенд в окне артефакта);
  // права — $uses: session + $session-read/$session-write, проверка — на хосте.
  var metaSubs = new Set()
  var metaSubscribed = false
  var metaLast = null
  var toolHandlers = new Map()
  function onSessionEvent(payload) {
    metaLast = payload
    metaSubs.forEach(function (fn) {
      try {
        fn(payload)
      } catch (e) {
        setTimeout(function () { throw e })
      }
    })
  }
  function onToolCall(call) {
    if (!call || !call.callId) return
    var fn = toolHandlers.get(call.name)
    function answer(result) {
      post({ __exz: 'tool-res', callId: call.callId, result: result })
    }
    if (!fn) return answer({ text: 'тул ' + call.name + ' не зарегистрирован в артефакте', error: true })
    Promise.resolve()
      .then(function () { return fn(call.args, call) })
      .then(
        function (v) {
          if (typeof v === 'string' || (v && typeof v === 'object' && typeof v.text === 'string')) return answer(v)
          answer(v === undefined || v === null ? '' : JSON.stringify(v))
        },
        function (e) { answer({ text: String((e && e.message) || e), error: true }) },
      )
  }
  var session = Object.freeze({
    meta: Object.freeze({
      /** Мета сессии: get() — документ, get('prompt.pre') — значение по пути. Result {ok, value, hash}. */
      get: function (path) { return call('session.meta.get', [path == null ? null : path]) },
      /** Записать значение по пути (null — удалить ключ); opts.ifHash — версия из get/on: чужая правка → {ok:false, code:'conflict', hash}. */
      set: function (path, value, opts) { return call('session.meta.set', [path, value === undefined ? null : value, opts || null]) },
      /** Подписка: cb({meta, hash, personas, sessionId, title}) при любой смене (чат, бэкенд, другой артефакт). Возвращает отписку. */
      on: function (cb) {
        metaSubs.add(cb)
        // Поздний подписчик получает последнее известное состояние сразу.
        if (metaLast) setTimeout(function () { if (metaSubs.has(cb) && metaLast) cb(metaLast) })
        if (!metaSubscribed) {
          metaSubscribed = true
          call('session.meta.on', []).then(function (r) {
            if (!r || !r.ok) {
              metaSubscribed = false
              if (typeof console !== 'undefined') console.warn('session.meta.on: ' + (r && r.error))
            } else if (r.value) onSessionEvent(r.value)
          })
        }
        return function () { metaSubs.delete(cb) }
      },
    }),
    personas: Object.freeze({
      /** {personas, userId}. */
      list: function () { return call('session.personas.list', []) },
      /** Персона по id; 'user' — персона игрока. */
      get: function (id) { return call('session.personas.get', [id]) },
      /** Одна персона — правка/добавление по id; массив (+ userId) — документ целиком. */
      set: function (personas, userId) { return call('session.personas.set', userId === undefined ? [personas] : [personas, userId]) },
    }),
    history: Object.freeze({
      /** Последние сообщения: [{id, role, text, personaId?, createdAt?}]; только чтение. */
      list: function (opts) { return call('session.history.list', [opts || {}]) },
    }),
    tools: Object.freeze({
      /** Тул для модели этой сессии; handler(args, call) → строка | {text, data?, error?} | объект (JSON). Снимается при закрытии вкладки. */
      register: function (decl, handler) {
        if (typeof handler !== 'function') return Promise.resolve({ ok: false, error: 'tools.register: нужен обработчик' })
        var name = decl && decl.name
        toolHandlers.set(name, handler)
        return call('session.tools.register', [decl]).then(function (r) {
          if (!r || !r.ok) toolHandlers.delete(name)
          return r
        })
      },
      unregister: function (name) {
        toolHandlers.delete(name)
        return call('session.tools.unregister', [name])
      },
    }),
  })

  // ── skins: редактор тем ────────────────────────────────────
  // Файлы скинов — на хосте (общие + .nr/skins рабочей области), валидатор
  // контракта там же; preview/apply исполняет фронт (тема — у клиента).
  // Право — $uses: skins. Все методы — Promise<{ok, value | error}>.
  var skins = Object.freeze({
    /** Скины: [{name, description, mode, base, source, hash, error?}] */
    list: function () { return call('skins.list', []) },
    /** Разбор скина: {info, source (текст файла), css (собранный), vars {common, light, dark}, chain} */
    get: function (name) { return call('skins.get', [name]) },
    /** Контракт: {groups, tokens [{name, group, kind, description}], selectors, properties, fontHosts} */
    contract: function () { return call('skins.contract', []) },
    /** Проверить без записи: {ok, errors?, warnings?, css?, vars?}; opts — {base?, mode?, description?} */
    check: function (name, css, opts) { return call('skins.check', [name, css, opts || null]) },
    /** Проверить и записать .nr/skins/<name>.skin.css рабочей области: {ok, path?, errors?} */
    save: function (name, css, opts) { return call('skins.save', [name, css, opts || null]) },
    /** Живое превью поверх nrchat (не сохраняется); preview(null) — снять. */
    preview: function (name, css, opts) { return name == null ? call('skins.preview', [null]) : call('skins.preview', [name, css, opts || null]) },
    /** Сделать скин текущим в nrchat (после save — перечитав список). */
    apply: function (name) { return call('skins.apply', [name]) },
  })

  // ── widget: артефакт — виджет поля универсального редактора ─
  // Поле рисуется кадром: значение и props — событием `widget`, правка — `change`
  // (одна команда object.set: undo редактора её откатывает), высота кадра — `size` (сама по ResizeObserver).
  var widgetInits = []
  var widgetLast = null
  var widgetFitting = false
  function onWidget(payload) {
    widgetLast = payload
    if (payload && payload.theme) applyTheme(payload.theme)
    widgetInits.forEach(function (fn) {
      try { fn(payload) } catch (err) { if (typeof console !== 'undefined') console.error(err) }
    })
  }
  function widgetFit() {
    var h = document.documentElement.scrollHeight
    if (h) call('widget.size', [h])
  }
  var widget = Object.freeze({
    /** fn({value, props, path, readOnly, theme}) — сразу с последним значением и на каждое новое. */
    onInit: function (fn) {
      widgetInits.push(fn)
      if (widgetLast) fn(widgetLast)
      if (!widgetFitting) {
        widgetFitting = true
        widgetFit()
        if (window.ResizeObserver) new ResizeObserver(widgetFit).observe(document.documentElement)
      }
      return function () {
        widgetInits = widgetInits.filter(function (f) { return f !== fn })
      }
    },
    change: function (value) { return call('widget.change', [value === undefined ? null : value]) },
    size: function (height) { return call('widget.size', [height]) },
  })

  var BLOB_TYPES = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
    bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
    json: 'application/json', txt: 'text/plain', pdf: 'application/pdf',
  }

  var host = {
    widget: widget,
    image: image,
    speak: speak,
    llm: llm,
    session: session,
    skins: skins,
    readFile: function (path) { return call('readFile', [path]) },
    readFileBinary: function (path) { return call('readFileBinary', [path]) },
    writeFile: function (path, content) { return call('writeFile', [path, content]) },
    listDir: function (path) { return call('listDir', [path]) },
    run: run,
    job: job,
    app: app,
    openDialog: function (filters) { return call('openDialog', [filters || null]) },
    clipboard: Object.freeze({
      read: function () { return call('clipboardRead', []) },
      write: function (text) { return call('clipboardWrite', [text]) },
      readImage: function () { return call('clipboardReadImage', []) },
      writeImage: function (bytes, mime) { return call('clipboardWriteImage', [bytes, mime || 'image/png']) },
    }),
    storage: Object.freeze({
      get: function (key) { return call('storage.get', [key]) },
      set: function (key, value) { return call('storage.set', [key, value]) },
    }),
    getContext: function () {
      return call('getContext', []).then(function (r) {
        return r && r.ok ? r.value : { file: null, extName: '', artifactId: cfg.id || '' }
      })
    },
    /**
     * Путь → URL для <img>/<video>/<audio>/загрузчиков: `/f/<key>/<папка>/<имя>` — оканчивается
     * именем файла (тип по расширению), относительные ссылки — в той же папке (код —
     * `fileUrlPath` хоста). Проверка $fs-read — на хосте при запросе.
     */
    fileUrl: function (path) {
      var p = String(path)
      if (p.indexOf('file://') === 0) p = decodeURIComponent(new URL(p).pathname)
      var at = p.lastIndexOf('/')
      var dir = at < 0 ? '.' : at === 0 ? '/' : p.slice(0, at)
      var name = at < 0 ? p : p.slice(at + 1)
      var tok = btoa(unescape(encodeURIComponent(dir))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      return (cfg.origin || '') + '/f/' + (cfg.key || '') + '/' + tok + '/' + encodeURIComponent(name)
    },
    /**
     * Путь → Result {ok, value: Blob} байтами моста (`readFileBinary`, то же право $fs-read), тип — по расширению.
     * Не зависит от origin и куки: картинку в canvas — `createImageBitmap(blob)` или `URL.createObjectURL(blob)`,
     * где `fileUrl` не дойдёт (стенд с ключом за чужим origin, удалённый клиент) —.
     */
    fileBlob: function (path) {
      return call('readFileBinary', [path]).then(function (r) {
        if (!r || !r.ok) return r
        var m = /\.([a-z0-9]+)$/i.exec(String(path))
        var type = (m && BLOB_TYPES[m[1].toLowerCase()]) || 'application/octet-stream'
        return { ok: true, value: new Blob([r.value], { type: type }) }
      })
    },
    on: function (event, cb) {
      var set = hostSubs.get(event)
      if (!set) hostSubs.set(event, (set = new Set()))
      set.add(cb)
      return function () {
        var s = hostSubs.get(event)
        if (!s) return
        s.delete(cb)
        if (s.size === 0) hostSubs.delete(event)
      }
    },
    service: Object.freeze({
      call: function (cmd, params, opts) { return call('service.call', [cmd, params == null ? null : params, opts || null]) },
      on: function (event, cb) {
        var subId = 's' + nextId++
        svcSubs.set(subId, cb)
        post({ __exz: 'svc-on', subId: subId, event: event })
        return function () {
          svcSubs.delete(subId)
          post({ __exz: 'svc-off', subId: subId })
        }
      },
    }),
    comfy: comfy,
    viewer: viewer,
    preview: preview,
    watch: function (path, cb) {
      var cbId = 'w' + nextId++
      watchers.set(cbId, cb)
      return call('watch', [path, cbId]).then(function (res) {
        if (!res.ok) {
          watchers.delete(cbId)
          throw new Error(res.error)
        }
        var watchId = res.value
        return function () {
          watchers.delete(cbId)
          post({ __exz: 'unwatch', watchId: watchId })
        }
      })
    },
  }

  if (cfg.theme) applyTheme(cfg.theme)
  Object.defineProperty(window, '__host', { value: Object.freeze(host), enumerable: true })
  post({ __exz: 'hello', id: cfg.id || null })
})()
