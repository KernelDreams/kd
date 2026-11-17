# @kerneldreams/secrets

Masks secrets in text before it leaves the machine: for bug-report bundles, chat-archive mining, logs. Zero
dependencies, no Node or DOM required.

```sh
npm i @kerneldreams/secrets
```

```ts
import { createMask, maskDeep, maskSecrets, secretValues } from '@kerneldreams/secrets'

maskSecrets('Authorization: Bearer abc…')            // key shapes + context
const mask = createMask({ values: secretValues(readFileSync(configPath, 'utf8')) })
mask(log)                                             // + exact values taken from your config
maskDeep(json, mask)                                  // strings inside JSON, secret-named fields masked whole
```

Recognized by shape: `sk-ant-…`, `sk-or-v1-…`, `sk-proj-…`, `sk-…`, Z.ai (`<32 hex>.<16>`), Google `AIza…`,
GitHub `ghp_…` / `github_pat_…`, npm `npm_…`, AWS `AKIA…`, Slack `xox?-…`, Projektor `pk_…` / `fbk_…`, Telegram bot
tokens, JWT, PEM, bare hex of 48+ characters. Recognized by context: `Authorization: Bearer|Basic`, `Bearer …`,
`?key=` / `&token=` / `api_key=`, `"apiKey": "…"`, `$key: …` / `TOKEN=…`, `X-Api-Key: …`. Keys with no shape of
their own (gateway keys, custom tokens) are caught only through `values` taken from your config.

The replacement looks like `sk-a…[secret]` (the first 4 characters are kept when the value is longer than 12).
