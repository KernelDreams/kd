/**
 * Preload-модуль для `node --import`.
 *
 * Единственная задача — побочный эффект: поставить resolve-хук runz до того,
 * как тестовый файл (или любой сторонний скрипт) выполнит свой первый импорт.
 * Так appz без package.json резолвят `@kerneldreams/nrd` под `node --test`.
 */

import { registerResolveHook } from './hook.ts'

registerResolveHook()
