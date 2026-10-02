# Contributing

Thanks for looking. A few things about this repository are unusual enough to be
worth reading before you spend time on a change.

## Where a change belongs

This is a fork of [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser).
The browser engine — the snapshot pipeline, the tool implementations, the
approval model, the bridge — is upstream's code. `COPYRIGHT.md` lists the files
this fork owns.

- **Engine defect** (a page that will not snapshot, a click that misses, a tab
  binding that goes wrong): please report it upstream. The code is theirs, and a
  fix there reaches more people.
- **Panel or interaction defect**: here.

## Before you send a change

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
```

Two things that catch people out:

**The bridge plugin must be rebuilt after editing it.** The desktop app loads
`packages/browser/bridge-browser/lib/`, not `src/`. Editing the source and
restarting the app changes nothing until you run its build. `pnpm run
check:build` reports this situation; it is why that script exists.

**The desktop app must be restarted for plugin changes.** Plugins are loaded once
at boot, and disabling and re-enabling one does not re-read the code. If your
change appears to do nothing, that is usually why.

## Layout changes

The panel is a side panel, so its width belongs to the browser and its height
changes with the window. jsdom has no layout engine, so unit tests cannot check
geometry. If you touch the panel's CSS or the composer's growth, run:

```sh
pnpm --filter dsh-browser-extension run test:layout
```

It drives real Chrome and measures eleven viewport sizes. A layout regression
here is invisible to the unit suite.

## Style

Match the file you are editing. Two conventions in this codebase are load-bearing
rather than cosmetic:

- **Comments explain why, not what.** A comment that restates the code will be
  removed. The comments worth keeping record a measurement, a constraint, or a
  decision that is not obvious from the code.
- **A test should fail if the behaviour is removed.** If you cannot describe what
  a test would catch, it is probably asserting the implementation rather than the
  behaviour.

## Reporting a bug

An issue that can be acted on includes the browser and its version, what you did,
what happened, and what you expected. If the panel is involved, a screenshot
helps — panel layout problems are hard to describe and easy to see. The console
output of the extension's service worker (`chrome://extensions` → the card's
"Inspect views: Service Worker") is the most useful single thing you can attach.
