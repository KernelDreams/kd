/**
 * Демо формы: все виджеты, секции (одна свёрнута), вариант над базой, «только
 * изменённые», списки моделей и файлов. `?theme=dark`, `?lang=ru` — строки хозяина.
 */

import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { buildSchema, defaultValues } from '../src/index.js'
import { FormView } from '../src/react.js'
import type { FormLabels, FormValue, ImageInput, OptionList, VariantOption } from '../src/react.js'
import './style.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.skin = 'parchment'
document.documentElement.dataset.mode = params.get('theme') === 'dark' ? 'dark' : 'light'

const FIELDS = [
  { name: 'ref', spec: 'image // Reference: what to restyle' },
  { name: 'prompt', spec: 'text // Prompt' },
  { name: 'style', spec: 'select anime, photo, sketch // Style' },
  { name: 'mood', spec: 'radio calm, loud // Mood' },
  { name: 'face', spec: 'checkbox // Face detailer' },
  { name: 'title', spec: 'string? // Title' },
  { name: 'model', spec: 'model // Model' },
  { name: 'judges', spec: 'model[] // Judges', section: 'review' },
  { name: 'rubric', spec: 'file rubric-*.md // Rubric', section: 'review' },
  { name: 'tags', spec: 'string[] // Tags', section: 'review' },
  { name: 'steps', spec: 'number // Steps', section: 'tune' },
  { name: 'seed', spec: 'number? // Seed', section: 'tune' },
  { name: 'refs', spec: 'image[]? // More references', section: 'tune' },
]

const BASE = { prompt: 'make it look like a watercolor', style: 'photo', face: 'false', model: 'gate/glm-5.3-flash', steps: '20', rubric: 'rubric-v2.md', judges: ['gate/glm-5.3-flash'] }
const VARS = { ...BASE, style: 'anime', steps: '28' }
const schema = buildSchema(FIELDS, VARS, {
  sections: [
    { id: '', title: '' },
    { id: 'review', title: 'Review' },
    { id: 'tune', title: 'Fine tuning', collapsed: true },
  ],
  own: new Set(['style', 'steps']),
  base: { name: 'base.mdz', vars: BASE },
})

const VARIANTS: VariantOption[] = [
  { file: 'base.mdz', title: 'Base', values: { style: 'photo', steps: 20 } },
  { file: 'anime.mdz', title: 'Anime', values: { style: 'anime', steps: 28 } },
]

const MODELS: OptionList = {
  items: ['gate/glm-5.3-flash', 'gate/gemini-pro-latest', 'mac/heretic'],
  infos: [
    { id: 'gate/glm-5.3-flash', name: 'GLM 5.3 Flash', owner: 'gate', contextWindow: 200000 },
    { id: 'gate/gemini-pro-latest', name: 'Gemini Pro', owner: 'gate' },
    { id: 'mac/heretic', owner: 'mac' },
  ],
  loading: false,
}
const FILES: OptionList = { items: ['rubric-v1.md', 'rubric-v2.md', 'rubric-strict.md'], loading: false }

const RU: Partial<FormLabels> = {
  variant: 'Вариант',
  variantCustom: 'свой (изменён)',
  variantThis: 'этот файл',
  onlyChanged: 'Только изменённые',
  changedCount: 'изменено: {n}',
  'origin.variant': 'вариант',
  'origin.run': 'запуск',
  revert: 'вернуть',
  addModel: 'добавить модель',
  add: 'добавить…',
}

function Demo() {
  const [values, setValues] = useState<Record<string, FormValue>>(() => ({ ...defaultValues(schema), prompt: 'a cat on a roof at dawn' }))
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [imageField, setImageField] = useState<string | null>(null)
  const image = (field: string, input: ImageInput) => {
    const path = input.kind === 'path' ? input.path : input.kind === 'url' ? input.url : (input.name ?? 'pasted.png')
    if (input.kind === 'bytes') setThumbs((t) => ({ ...t, [path]: URL.createObjectURL(new Blob([input.data.slice()], { type: input.mime })) }))
    setValues((v) => ({ ...v, [field]: schema.properties[field]?.type === 'array' ? [...((v[field] as string[]) ?? []), path] : path }))
  }
  return (
    <main className="mx-auto max-w-3xl py-nr-4">
      <FormView
        template={{ id: 'demo', file: '/demo/anime.mdz', schema }}
        values={values}
        thumbs={thumbs}
        imageField={imageField}
        disabled={false}
        onChange={(field, value) => setValues((v) => ({ ...v, [field]: value }))}
        onImage={image}
        onImageFocus={setImageField}
        onPasteClipboard={() => undefined}
        onSubmit={() => console.info('submit', values)}
        collapsed={(id) => collapsed[id]}
        onToggleSection={(id, def) => setCollapsed((c) => ({ ...c, [id]: !(c[id] ?? def ?? false) }))}
        options={(widget) => (widget === 'model' ? MODELS : FILES)}
        onOptions={() => undefined}
        onReset={(field) => setValues((v) => ({ ...v, [field]: defaultValues(schema)[field]! }))}
        origins
        onlyChanged={onlyChanged}
        onOnlyChanged={setOnlyChanged}
        variants={VARIANTS}
        onVariant={(variant) => setValues((v) => ({ ...v, ...variant.values }))}
        onOpenFile={(path) => console.info('open', path)}
        {...(params.get('lang') === 'ru' ? { labels: RU } : {})}
      />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
)
