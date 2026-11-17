// Модель схемы (node-canvas-spec §3): без UI, правка — командами документа ядра forms.
export * from './types.js'
export { createSchemaDocument, entityOf, freshVarName, SCHEMA_COMMANDS, SCHEMA_MODEL_SCHEMA, type SchemaDocument, type SchemaDocumentOptions } from './document.js'
export { compositeToText, lineToRow, partsFromNtpl, partsToNtpl, pillToNtpl, rowToLine, RowProjectionError } from './ntpl.js'
export { typeFromJsonSchema, typeToJsonSchema } from './typedefs.js'
