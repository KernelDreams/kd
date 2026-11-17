/**
 * Строки интерфейса формы (английские по умолчанию). Хозяин передаёт свои —
 * `labels` у `FormView`; `{name}` — подстановка значения.
 */
export const LABELS = {
  add: 'add…',
  addModel: 'add model',
  brokenTemplate: 'The template form is broken: {error}',
  changedCount: '{n} changed',
  clear: 'clear',
  imageHint: '⌘V, drop a file, or paste a path / URL + Enter',
  imagesHint: 'drop images, ⌘V or',
  imagesPick: 'Choose…',
  onlyChanged: 'Only changed',
  openFile: 'open',
  openFileHint: 'Open {file} in the viewer',
  optionsEmpty: 'no options — type a value',
  optionsError: 'list unavailable: {error}',
  optionsLoading: 'loading the list…',
  pasteImage: 'paste image from clipboard',
  removeItem: 'remove',
  revert: 'revert',
  revertRun: 'Back to the file value',
  revertVariant: 'Back to {base} (saving removes the line from the file)',
  modelOff: 'off',
  modelNone: 'not chosen',
  variant: 'Variant',
  variantCustom: 'custom (changed)',
  variantThis: 'this file',
  'origin.recipe': 'recipe',
  'origin.variant': 'variant',
  'origin.run': 'run',
  'originHint.recipe': 'Value from recipe {base}',
  'originHint.variant': 'Set in this variant over {base}',
  'originHint.run': 'Changed here, not saved — goes into this run',
  required: 'required',
}

export type FormLabels = Record<keyof typeof LABELS, string>
