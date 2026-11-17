# @kerneldreams/plugins

Plugins for nrchat: install from a git URL, a lock file with rollback, registry repositories and a cascade of
sources. Node only, no dependencies beyond the machine's `git`.

```sh
npm i @kerneldreams/plugins
```

```ts
import { installFromGit, updatePlugin, rollbackPlugin, syncRegistries, normalizeRegistries, resolvePlugins } from '@kerneldreams/plugins'

installFromGit(layer, 'https://git.example.com/me/nrp-gray.git#v1.0.0')  // clone into <layer>/gray, lock, $plugins
updatePlugin(layer, 'gray')            // newest tag (or an explicit one); roll back with rollbackPlugin
syncRegistries(layer, normalizeRegistries(['https://git.example.com/me/nr-plugins.git']))
resolvePlugins(layer)                  // catalog + what works: forms (.mdz), artifacts, code
```

The user layer `<layer>` (`<data>/plugins`) holds: `plugins.mdz` (`$plugins`, `$choose`), `plugins.lock.json`,
`registries.json`, `.registries/<id>/` (registry clones, read-only), `<id>/` (clones installed by URL), and your own
`*.mdz` files and folders — edited copies of registry plugins (a registry update does not touch them).

- Kinds: `file` (an `.mdz` with `## $form`), `artifact` (`meta.mdz` / `index.html`), `code` (`package.json` →
  `nrchat`, with `dist/index.js` committed in the repository — nothing is built on the user's machine; with no build,
  the plugin is reported as "not built").
- Version = a git tag. The pinned commit is installed; without a pin, the newest version tag; with no tags, HEAD.
- The same id from two registries is never picked silently: the catalog lists `candidates`, and you choose with
  `choosePlugin`.
- `apiMismatch(host, range)` / `satisfies` live in `@kerneldreams/plugins/semver`, which is Node-free (usable for
  checks in a frontend).
- Publishing: `publishEntry({registry, source})` writes an `entries/<id>.mdz` record from a URL, or a file/folder
  into `plugins/`, then commits and pushes.

```
npm run build && npm test
```
