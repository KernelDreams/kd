# @kerneldreams/runz

The `runz` command line: it runs TypeScript scripts and NRD documents (`.md`, `.mdz`, `.mdd`, `.mds`), resolves a chain of config files, ships built-in scripts, and provides `runz add` and `runz test`. The runtime lives in `@kerneldreams/runz-runtime` (loading, registry, config chain, resolve hook); the CLI itself is a thin `bin/runz.ts`.

```
npm i -g @kerneldreams/runz
```

Node >= 24.

```
runz <script> [--key=value ...]
runz <document.mdz> [--key=value ...]
runz add <package> [--global]
runz test [target] [--filter=<substr>]
runz --help
```

A minimal script is a TypeScript file that exports a function of `(ctx, meta)`; a document with a `$handler` or `## $step` blocks is run as a program. Command-line arguments enter the same value chain as config files, so `--key=value` can be read as `${key}` from a document.

- The CLI root is `RUNZ_HOME` (the package directory by default): built-in `scripts/` and the `node_modules` used to resolve scripts that live outside the package tree (scripts without their own `package.json`).
- Config chain: `~/.runz/config.md`, the project's `.runz/config.md`, and `--runz-config=<file>`.
- The package has no private dependencies. Subscription-based model providers are plugged in as files `~/.runz/providers/<type>.ts`; extra packages for a script come from a `.runz/node_modules` next to it.
- For a newer entry point over the same runtime, see `@kerneldreams/kd`.

Specification: `docs/specs/runz.md`; guidance for script authors: `skills/runz.skill/SKILL.md`.

Tests: `npm test` (vitest, rooted at the package directory).

## License

MIT
