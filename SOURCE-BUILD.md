# How to rebuild this add-on from source

This archive accompanies the submitted `-store-firefox.zip`. Mozilla requires it because the
submitted package contains minified bundles, and a reviewer must be able to reproduce them from
readable source.

## Toolchain

- Node.js **>= 20**
- pnpm (`corepack enable && corepack prepare pnpm@latest --activate`, or `npm i -g pnpm`)

No other tools, no network access beyond the package registry, and no code generation or
transpiler beyond the ones the commands below install.

## Build

From the archive root:

```sh
pnpm install --frozen-lockfile
pnpm --filter dsh-browser-extension run build:store:firefox
```

That writes `extension/dist-store-firefox/`, whose contents are exactly what was submitted in
`dsh-browser-crossplatform-<version>-store-firefox.zip`.

`package` (below) is what actually produces the zip, and it needs both the Chrome and Firefox
development builds to exist first because it reads the version out of both manifests:

```sh
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run build:store
pnpm --filter dsh-browser-extension run build:store:firefox
pnpm --filter dsh-browser-extension run package
```

## What the build does

`extension/scripts/build.mjs` runs esbuild over three entry points —

| Entry | Output |
|---|---|
| `extension/src/background/index.ts` | `background.js` (MV3 service worker) |
| `extension/src/content/index.ts` | `content.js` (page reader and action executor) |
| `extension/control/main.ts` | `assets/index.js` (the side panel) |

— plus `control/styles.css` → `assets/index.css`, and copies `manifest.json` (or
`manifest.firefox.json`), the icon set, `_locales/` and `control/index.html`. `--store` omits the
manifest `key` field, which the stores reject; `--firefox` selects the Firefox manifest and
target. Minification and bundling are the only transformations; there is no obfuscation, no
remote code, and no dynamically evaluated code.

## Layout

```
extension/          the add-on
  src/background/   service worker: bridge connection, sessions, approvals, image relay
  src/content/      page reader and action executor
  src/shared/       code shared by both
  control/          the side panel (vanilla TypeScript, no framework)
  scripts/          build.mjs, package.mjs, extension-id.mjs
  tests/            vitest suites
  manifest.json     Chrome / Edge
  manifest.firefox.json
packages/protocol/  wire types shared with the desktop app (source-only, no build step)
packages/bridge/    the desktop-side plugin; not part of the add-on
package.json        workspace root
pnpm-workspace.yaml
pnpm-lock.yaml
```

## Tests

```sh
pnpm -r run typecheck
pnpm -r run test
```
