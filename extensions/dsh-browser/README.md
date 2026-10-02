# dsh Browser Hand & Eye (Chrome and Firefox MV3)

English | [中文](README.zh.md)

The **browser-operation end** of dsh. The desktop DSH app drives it: the model
reads and operates the page you already have open — extract content, click
elements, fill forms, scroll, navigate — inside your real browser, with your
login state, cookies, and sessions intact.

This extension has **no chat UI of its own**. dsh's own window is the only
conversation surface; the extension is the executor plus a small toolbar
control strip for connection state, approvals, and settings.

## What the model can do

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Title/URL/main text/numbered inventory/form fields (sensitive values masked); `delta: true` returns only changes |
| Click element | `browser_click` | Click by inventory number (links/buttons/checkboxes…), React/Vue compatible |
| Fill forms | `browser_type` | Type text; `replace` clears first |
| Keys | `browser_press` | Enter/Tab/Escape/arrows and so on |
| Scroll | `browser_scroll` | Viewport scrolling (up/down/top/bottom) |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Inside the controlled tab, or open a URL in a new tab and follow it |
| List tabs | `browser_list_tabs` | Accessible tabs with stable IDs, titles, URLs, and state |
| Follow tab | `browser_follow_tab` | Bind later tools to a listed tab without activating it |
| Close tab | `browser_close_tab` | Close a listed tab |
| Read region | `browser_get_text` | Lazy-loaded content / partial text |
| Wait | `browser_wait` | Page load and render-settle detection |

Page state is always rendered as **structured text** — a numbered inventory of
interactive elements with stable numbers across snapshots. Browser tools never
take screenshots.

## Architecture

```
dsh desktop window (the only chat UI)
        │  browser_* tool calls
        ▼
dsh bridge plugin (server side, inside the dsh process)
        │  WebSocket  ws://127.0.0.1:<port>/ext/bridge
        ▼
background service worker ──port "dsh-control"──▶ control strip (toolbar popup)
        │  tabs.sendMessage (DSH_ACTION)
        ▼
content script (snapshot / actions / privacy)
```

- **background** (`src/background/`): owns the bridge socket (token auth,
  auto-discovery, exponential-backoff reconnect, keepalive), fail-closed tool
  dispatch into a single user-controlled tab, tab affinity, approval
  coordination, and the short `dsh-control` port protocol.
- **content script** (`src/content/`): text-only snapshot (readability main text
  + numbered interactive inventory + form fields), stable element numbers
  (`data-dsh-el`), delta changes, click/type/press/scroll/navigate actions, and
  sensitive-field masking.
- **control strip** (`control/`): a dependency-free vanilla-TS popup showing
  connection state, the controlled tab, pending approvals, safety settings, a
  short activity log, and the bridge address. It closes whenever you click away
  — nothing in the worker depends on it staying open.
- **protocol**: `protocol.ts` in the `@yuxianglin/dsh-bridge-browser` workspace
  package is the single source of truth, shared by both ends.

## Build

From the repository root:

```sh
pnpm install
pnpm --filter dsh-browser-extension run build            # Chrome/Edge -> dist/
pnpm --filter dsh-browser-extension run build:firefox    # Firefox     -> dist-firefox/
pnpm --filter dsh-browser-extension run test
pnpm --filter dsh-browser-extension run typecheck
```

## Install and use

1. Build (above), then load the output:
   - **Chrome/Edge**: `chrome://extensions` → enable Developer mode →
     *Load unpacked* → select `extensions/dsh-browser/dist/`.
   - **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary
     Add-on* → select `extensions/dsh-browser/dist-firefox/manifest.json`.
2. Make sure dsh is running with the bridge plugin mounted, then open any normal
   `http://` or `https://` page and click the whale icon.
3. The control strip shows the connection. Chrome loopback connections need no
   address or token; Firefox must be given the token from
   `~/.dsh/ext-bridge-token`, because a `moz-extension://` UUID is not an add-on
   identity.
4. Talk to the model in the dsh window. Ask it to read or operate the page; the
   first call binds the tab you are looking at.

**Desktop DSH users**: the desktop app may assign a random local Web port. The
extension auto-discovers the usual ports (3080, 3081, 3090, 14389, 43189,
19387); if yours differs, paste `http://127.0.0.1:<port>` into the control
strip's *Bridge address*. Pinning the port to `43189` in the desktop settings
keeps auto-discovery working.

Pages that were already open before the extension was installed or reloaded are
instrumented on the first action, so they need no manual refresh.
Browser-internal and protected pages (`chrome://`, the Web Store) expose only tab
metadata and browser-level navigate/back/forward/reload; their DOM cannot be read
or operated.

## How the connection works

- **Connects on load, not on click.** There is no panel to wait for: the worker
  starts connecting as soon as settings are read, and a half-minute `alarms`
  heartbeat keeps both the socket and the MV3 worker alive. *Auto connect* in
  the control strip is the one way to stop it.
- **One browser at a time.** A second open profile is told to yield (close code
  4000) instead of fighting for the slot.
- **Nothing is read from the page until a tool asks.** Snapshots and text reads
  are enclosed in a fresh nonce-bound trust marker that tells the model to treat
  page text as untrusted data.

## Approvals and safety

Approvals are the enforcement boundary, and the control strip is not the only
way to answer one — because it is closed most of the time:

- The default `auto` mode lets the model read the controlled tab without an extra
  prompt; `ask` restores per-read confirmation; `off` blocks reads.
- State-changing tools fail closed and show their exact origin plus a redacted
  action summary. You may deny, allow once, or trust one origin for the current
  bridge session (the strip lists temporary grants and can revoke them).
- When the control strip is closed, an approval becomes a **system
  notification** and a **red badge count** on the toolbar icon. Clicking either
  opens the strip on that request. You have two minutes to decide.
- **Allow unrestricted browser control** is an explicit global switch that only
  takes effect after the setting is saved, and then lets page reads, page
  actions, and tab list/follow/close run without confirmation. Protected-page DOM
  content stays inaccessible either way.
- A manual tab or window switch pauses later tools and asks whether to stay on
  the original page or follow the new one; *keep and stop asking* pins it.
  Closing the controlled tab fails closed until you bind the current page.
- Password and credit-card values always render as `••••` and never leave the
  page.

## Permissions

`storage` (settings and controlled-tab continuity), `tabs` + `activeTab` +
`scripting` (observe tab changes and inject/message only the explicitly
controlled tab, including lazy recovery for pages opened before install),
`webNavigation` (bind messages to that tab's frame documents), `alarms`
(background keepalive), `notifications` (approvals received while the control
strip is closed), and `http/https` (content-script injection on normal pages).
There is no `sidePanel` permission: this extension has no sidebar.

The extension never changes the visible tab or silently follows a manual switch;
background operation happens only after you choose to stay on the original page.

## Differences from the upstream sidebar build

This tree is the lightweight, desktop-oriented build. Compared with the upstream
`dsh-browser` extension it **removes** the React side-panel chat client (session
list, history, image attachments, model picker, update card, markdown rendering,
text-selection quotes, `ask_user_question` cards, transient event replay, and the
whole gateway RPC channel) and **adds** auto-connect, a vanilla control strip,
pending-approval replay, badge counts, and a two-minute approval window. The
bridge protocol is unchanged, so the same dsh-side plugin serves both builds.

## Known limitations

- Only one extension connection at a time.
- Tab affinity is global to that connection, not per conversation: several chat
  sessions share one controlled tab.
- Captcha and image-only controls cannot be handled; the tool result asks you to
  complete that step manually.
- No automatic token rotation.
- Synthetic `browser_press` events do not trigger browser-native defaults such as
  Tab focus movement, arrow-key scrolling, or Enter activation.
- `browser_wait` considers page load plus a fixed quiet window; a live-updating
  SPA may be reported as stable.
