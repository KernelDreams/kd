/**
 * `@kerneldreams/runz-run` — общий раннер шаблонов runz (forms-spec §4.1): материализация
 * значений в документ запуска и запуск `runz <файл> --runz-json` отдельным процессом.
 * Два фронта над одним контрактом: pi-ext-image (значения даёт модель тулом) и
 * плагин forms (значения вводит человек формой).
 */

export { materialize, nrdString, valueBlock, type TemplateValue, type TemplateValues } from './template.js'
export { parseResult, runFile, runTemplate, spawnCommand, type SpawnCommand, type RunFileOpts, type RunOpts, type RunResult, type ScriptArtifact } from './run.js'
