# dsh Browser Extension

**English** | [中文](README.zh.md)

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tabs you are already using. The model can read page content, operate controls, navigate, and manage tabs while preserving your login state, session, and cookies. A browser side panel is the conversation UI: you type there, replies stream back there, and each tool run is one quiet line.

> [!NOTE]
> **This is a lightweight derivative of [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser)**, not the upstream project. The browser engine is upstream's: the text snapshot pipeline, the numbered-control addressing, the tool implementations, the approval and trust model, and the bridge. What differs is the interaction layer — the React panel was replaced with a small side-panel control strip — plus a few additions described under [What this build changes](#what-this-build-changes). Engine problems belong upstream; panel problems belong here.

> [!IMPORTANT]
> **Publishing a fork of this?** Replace `youbaiyun/dsh-browser-application` with your own `owner/name` everywhere before you push. The string appears 16 times: in this file, in `README.zh.md` (including the badge at the top), and once each in `REPOSITORY` in `scripts/install.sh` and `$Repository` in `scripts/install.ps1`. Left unreplaced, the one-line installer downloads **upstream** and installs the larger build instead of this one — the opposite of the point. Upstream's `.github/FUNDING.yml` is deliberately not carried here, so there is no sponsorship account to redirect.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome/Firefox MV3 extension as one standalone pnpm workspace.

Browser operation remains text-only: pages become structured text with a numbered inventory of interactive elements, and the model addresses those elements by number. No screenshots are taken, ever.

> [!IMPORTANT]
> The workspace pins dsh 0.2.0-rc.2, the minimum supported runtime. Older DSH releases are not supported.

## What this build changes

Everything below is measured against upstream at the fork point, not estimated.

**Replaced: the interaction layer**

| | Upstream | This build |
|---|---|---|
| Panel | React app, 22 files, 8 520 lines | Plain TypeScript, 7 files, 2 827 lines |
| Panel tests | 3 088 lines, 19 files | 2 784 lines, 5 files |
| Features removed with it | text-selection quoting, question cards, update cards, UI scale, image attachments | — |

**Added: things upstream does not have**

- **A panel origin marker.** Every prompt typed in the panel is sent with a fixed prefix, so the model can tell a real instruction from a sentence a web page planted. The prefix is applied on the only code path that submits a prompt, so impersonation is a property of the architecture rather than something the model is asked to police.
- **`openPagesForUser`, an app-side switch.** Whether the model may open and navigate pages is a desktop-app setting, sent to the extension in the handshake. Turning it off swaps the prompt rule for a denying one, makes `@open` refuse, and suppresses automatic panel opening. The extension never keeps its own copy: a missing policy reads as "not allowed", so a dropped field cannot hand out a grant.
- **`@open`, a deterministic command.** Typing `@open <url>` in the panel opens the page, brings it forward, and binds it without involving the model at all. "Show me this" has to be a guarantee, not a request the model may decline.
- **Address recovery.** The desktop app picks its port at startup, so a restart can land elsewhere. After three failed probes the extension re-runs discovery instead of dialling a dead port forever.
- **A replaced-connection notice.** When another browser takes the single bridge slot, the panel says so and offers to take the connection back, instead of showing a generic failure.

**Kept exactly as upstream wrote it:** the snapshot pipeline (`snapshot.ts`, `extract.ts`, `ids.ts`, `privacy.ts`), the tool implementations, the approval and trust model, the bridge server and its authentication, the tab-affinity logic, and their tests. 78 files are byte-identical.

## Quick install

The standard `dsh plugin` command alone cannot install this project. The integration contains both a dsh bridge plugin and a browser extension. The one-line installer currently sets up the Chrome build.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/youbaiyun/dsh-browser-application/refs/heads/main/scripts/install.sh | bash
```

Windows, in PowerShell:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/youbaiyun/dsh-browser-application/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

The installer builds and registers the bridge, builds the extension, copies it to `~/.dsh/browser-extension`, puts that path on your clipboard, and opens `chrome://extensions`. Then two things need you rather than the script:

1. **Load the extension** — turn on **Developer mode**, click **Load unpacked**, and paste the path (or pick `%USERPROFILE%\.dsh\browser-extension`).
2. **Pin it to the toolbar** — a new extension is **not** pinned, and no extension can pin itself; Chrome removed that ability. Click the puzzle-piece icon beside the address bar, then the pin next to *dsh Browser Extension*. **Skipping this is the most common way to conclude the install failed when it did not** — the icon exists, it is simply inside the menu.

**Full walkthrough, with the prerequisites, what the script does at each step, and troubleshooting: [INSTALL.md](INSTALL.md).** It covers the pinning step in detail, the Edge conflict (only one browser can hold the bridge connection), and how to uninstall.

If dsh is already running, restart it after installation.

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. This project is not currently published as an npm package; use the installer above.

## Performance

The figures below were measured by upstream on the browser engine — the snapshot pipeline, the tool implementations and the bridge — which this fork reuses unchanged. They were **not** re-run against this build, and the panel replacement does not affect them either way, since the panel sits outside the measured path. They are reproduced because the engine is the same code; treat them as upstream's numbers, not this repository's.

In a paired 60-run end-to-end benchmark on August 18, 2026, both backends completed all 30 assigned runs successfully, while the engine required fewer model/tool round trips and finished faster:

| Backend | Success | Mean end-to-end latency | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** (upstream) | **30/30** | **5.32 s** | **3.4** |
| Matched Playwright baseline | 30/30 | 6.67 s | 4.7 |

The paired Playwright / extension duration ratio was **1.24** (95% CI **1.16–1.34**): Playwright took about 24% longer, or equivalently, the extension reduced latency by about 20% and saved 1.35 seconds per task on average. The suite used six browser tasks, five deterministic seeds, the same DSH profile and model (`deepseek-v4-flash`), and independently validated page state. See the [benchmark methodology and reproduction guide](benchmark/README.md) to run it yourself.

## Core capabilities

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Structured text snapshot: title, URL, main text, numbered controls, and masked form fields; `delta: true` returns only changes |
| Click element | `browser_click` | Click links, buttons, checkboxes, and other controls by inventory number |
| Fill forms | `browser_type` | React/Vue-compatible input; `replace` clears the field first |
| Press keys | `browser_press` | Keyboard events such as Enter, Tab, Escape, and arrow keys |
| Scroll | `browser_scroll` | Viewport scrolling: up, down, top, and bottom |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, or open a URL in a new tab and follow it (`active:false` keeps the current tab in front) |
| List tabs | `browser_list_tabs` | List accessible tabs with stable IDs, titles, URLs, window/index metadata, and active/controlled state |
| Follow tab | `browser_follow_tab` | Bind later browser tools to a tab returned by `browser_list_tabs` without activating it |
| Close tab | `browser_close_tab` | Close a tab returned by `browser_list_tabs` |
| Read region | `browser_get_text` | Lazy-loaded or partial page text |
| Wait for stability | `browser_wait` | Page-load and render-settle detection |
| Open a page for me | `@open` in the panel | You type `@open <url>` and the extension opens it, brings it to the front, and binds it — without asking the model. Optional `pace=` and `pin=` |

## Repository layout

```
packages/browser/bridge-browser/   dsh-side bridge plugin (WebSocket carrier + browser_* tools)
extensions/dsh-browser/            Chrome / Firefox MV3 extension (the side panel)
skills/dsh-browser-Application-troubleshooting/        troubleshooting skill, read by the model when something breaks
scripts/install.sh
scripts/install.ps1
```

The skill is documentation, not code: nothing depends on it at runtime, but an
assistant that has read it can diagnose the bridge, the extension, and the panel
without asking you. It ships in this repository so an installed copy is not the
only one in existence.

## Why this design

- **Your real browser, not a headless copy**: the model works in the page you already have open, retaining logins, sessions, and cookies.
- **A text-first page interface**: numbered controls, stable IDs across snapshots, delta updates, and masked sensitive values make pages operable without screenshots; user-attached chat images use dsh's separate multimodal message path.
- **A panel that is only a conversation**: the side panel shows what was asked, what was answered, and one quiet line per tool run. No dashboards, no step counters, no artwork.
- **Showing beats describing**: when seeing a page is the fastest way to what you want, the model opens it instead of pasting its text — subject to the `openPagesForUser` switch below.
- **A narrow privacy boundary**: passwords and payment-card values are always rendered as `••••` and never leave the page.
- **A guarded bridge**: authenticated handshakes protect remote connections, privileged gateway methods reject non-loopback callers, and the extension binds tools to one user-controlled tab.
- **Panel text is marked as yours**: every prompt typed in the panel is prefixed so the model can tell a real instruction from a sentence a web page planted.

## Detailed installation and usage

Requirements: Node.js `^22.19` or `>=24`, Corepack/pnpm, and Chrome 116+ or Firefox 140+. Windows additionally needs Windows PowerShell 5.1, which ships with Windows, or PowerShell 7+.

### Install or update

For a managed installation, run:

```sh
curl -fsSL https://raw.githubusercontent.com/youbaiyun/dsh-browser-application/refs/heads/main/scripts/install.sh | bash
```

or, on Windows:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/youbaiyun/dsh-browser-application/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

The installer downloads `main`, builds and registers the bridge plugin, builds the Chrome extension into `~/.dsh/browser-extension`, and opens `chrome://extensions`. On the first install, load that directory as an unpacked extension; on updates, click **Reload**. **Then pin it** — see [INSTALL.md](INSTALL.md#④-把扩展固定到导航栏) for why that step is not optional. Restart dsh if it is already running.

`scripts/install.sh` covers macOS and Linux, and `scripts/install.ps1` covers Windows; both write the same managed workspace and the same install metadata. The installer copies the extension path to the clipboard when a clipboard tool is available (`pbcopy`, `wl-copy`, `xclip`, `xsel`, or PowerShell's `Set-Clipboard`), and prints the path either way. When no Chrome or Chromium install is found, it prints the command that installs one; set `DSH_INSTALL_BROWSER=1` to let the installer attempt that install itself.

The Windows command downloads `install.ps1` and runs it rather than piping it into `Invoke-Expression`: the script is UTF-8 with a byte order mark so Windows PowerShell renders its Chinese output, and `Invoke-Expression` rejects a leading mark. Local checkout paths may contain spaces; the installer registers the bridge through a profile-local directory junction so the package spec never contains the absolute Windows path.

To install the current branch from a source checkout instead:

```sh
git clone https://github.com/youbaiyun/dsh-browser-application.git
cd dsh-browser
./scripts/install.sh
```

On Windows, run `.\scripts\install.ps1` from the checkout instead. After pulling or switching revisions, rerun the installer and reload the extension.

### Firefox source build

Firefox uses a separate MV3 manifest, event-page background, and sidebar. Build it from a checkout, then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extensions/dsh-browser/dist-firefox/manifest.json`:

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

The bridge address is still auto-discovered. Firefox's `moz-extension://` UUID does not authenticate an add-on, so it must present the bearer token from `~/.dsh/ext-bridge-token` (the dsh startup log reports that file's path). The extension has no token field: on the Firefox build, set it once from the extension's background console, which you open from `about:debugging#/runtime/this-firefox`:

```js
chrome.storage.local.get('dshSettings').then(({ dshSettings }) =>
  chrome.storage.local.set({
    dshSettings: { ...dshSettings, token: '<contents of ~/.dsh/ext-bridge-token>' },
  }))
```

Chrome over loopback needs no token, so this step does not apply there. Signed distribution can package the same `dist-firefox/` output.

### Start and use

Start the managed installation with:

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

From a source checkout, run `pnpm start` in the repository root. The exact supported public runtime is:

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

Local Chrome use requires no configuration; Firefox requires the local bridge token described above. The extension connects automatically as soon as it loads; click the DeepSeek whale icon to open the side panel and check the connection. Existing HTTP(S) tabs are instrumented on the first action. On browser-protected pages and extension stores, the model can read tab metadata and use browser-level HTTP(S) navigation, back, forward, and reload, but it cannot inspect or operate the protected page DOM.

## Troubleshooting

**The side panel stays "Not connected"**

- Make sure the desktop app is running.
- Verify the bridge is loaded: open `http://127.0.0.1:3080/ext/bridge-config`. It should return JSON such as `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`. If it returns a web page instead of JSON, the running dsh predates the bridge registration — restart dsh. The extension reclaims the connection on its own the next time you open the panel.
- The extension probes ports 3080, 3081, 3090, 14389, 43189, and 19387 automatically. If dsh runs on another port, or you use a remote `--host 0.0.0.0` deployment, set the address (and token on Firefox) from the extension's background console as shown above — the panel deliberately has no field for it.
- After changing bridge code or plugin configuration, **restart the desktop app**: plugins are read once at startup, and disabling/re-enabling one does not re-read them. After rebuilding the extension, reload it at `chrome://extensions`.
- The bundled `skills/dsh-browser-Application-troubleshooting/` skill covers the remaining cases in more detail, including reading the extension's real settings from `chrome.storage.local`.

## Development

The bridge plugin and Chrome/Firefox extension are both members of this repository's workspace. Run all commands from the repository root. For the first development installation, run `pnpm install`.

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:runtime
pnpm run test:smoke

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin must have a built `lib/` before startup because the loader consumes it; both `scripts/install.sh` and the root `pnpm run build` build the plugin before the extension.
- The bridge build copies its browser client with Node.js `copyFileSync`, so the same package script works without a Unix `cp` executable.
- The dependencies of `@deepseek-ai/dsh` and the bridge plugin are pinned to the same tested public release line. An upgrade must update the manifests and lockfile together and rerun the root checks.

`check:runtime` checks the resolved DSH dependencies and lockfile. `check:build` reports a source file that is newer than the artifact built from it. `test:smoke` starts the real web host in a temporary DSH home and exercises the bridge, session reads, and a restart, without model credentials.

CI runs a **required** job (`check:runtime`, `typecheck`, `test`, `build`, `check:build`) and a separate **informational** job for `test:smoke`. The smoke job currently fails at its session-disposal assertion on DSH 0.2.0-rc.2 — the same way in this fork and upstream, in code this fork does not own — so it reports rather than blocks. See "Known issues" in [CHANGELOG.md](CHANGELOG.md).

If you encounter `cache.hydratePrepared is not a function`, update the repository, rerun `pnpm install --frozen-lockfile` and `pnpm run build`, then restart `pnpm start`. Session data and the global package cache can be kept.

## Security

- The bridge path sits outside the `/api` trust boundary and performs its own bearer-token authentication.
- Local Chrome extension origins retain zero-configuration loopback access; Firefox origins are per-install UUIDs and must present the bearer token.
- Privileged gateway methods such as `settings.*`, `credentials.*`, and `host.open*` reject non-loopback sources.
- The browser-page pipeline is text-only and never captures screenshots; explicitly attached chat images use dsh's durable attachment service. Password and payment-card values never leave the page.
- When work begins, the assistant binds to the active tab (at prompt submission, or at the first direct browser-tool call). If you switch tabs manually, later browser actions pause and the side panel asks whether the assistant should continue on the original tab or follow the new one. Choosing the original tab permits background operation; the extension never silently retargets or changes your visible tab. Closing the controlled tab also pauses tools until you explicitly select the current page.
- Page-authored text is wrapped as untrusted input. The default `auto` mode reads only the controlled tab without an extra prompt; privacy-sensitive users can select `ask` for per-read confirmation or `off` to block reads entirely. Read page text is sent to the selected model.
- Click, type, keypress, navigation, history, and reload calls fail closed until the user approves them. An origin may be trusted for the current connection (cleared when the socket drops), while permanent trust is stored in the extension's settings. Explicit cross-origin `browser_navigate` calls and unknown history destinations always prompt again.
- **Allow unrestricted browser control** is an explicit global opt-in. It becomes active only after the setting is saved successfully; while enabled, page reads, page actions, and tab list/follow/close operations run without approval prompts. Calls capture their access mode when received, so enabling unrestricted control never retroactively elevates an existing restricted call. Disabling it takes effect immediately, cancels calls that have not dispatched an action, waits for already-dispatched browser operations to settle, and only then saves the restrictive setting. A rapid re-enable remains restricted until that revocation finishes, and concurrent saves persist in request order. Browser-protected DOM content remains inaccessible in either mode.
