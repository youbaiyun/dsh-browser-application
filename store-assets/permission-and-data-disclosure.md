# Permission justifications

The Chrome Web Store asks for a written reason for each permission and host
pattern. These are the answers, written to be pasted into the form.

## Why these are worth reading before submitting

`http://*/*` and `https://*/*` are the broadest host patterns the store offers,
and they are the ones most likely to trigger a manual review or a rejection
without a clear reason. The justification below is true and specific: the user
picks the page, so the manifest cannot know it in advance.

## Permissions

**`sidePanel`**
The conversation interface is a side panel. There is no popup and no separate
tab; the panel is where the user types and where replies appear.

**`storage`**
Remembers the bridge address and token, plus the user's preferences (page-content
sharing mode and tab-switch behaviour; "whether the model may open pages" is a
desktop-side setting, read here and not stored by the extension), the tab the
affinity layer is currently bound to, the desktop session id it last mirrored, and
whether the first-run note has been shown. Settings survive
a browser restart. It also keeps the description it produced for each image the
user asked about — keyed by that image's address, so asking twice does not fetch
or describe it twice. That memo is kept in **local extension storage for up to 24
hours** (bounded to the 200 most recent images; a transient failure is retried at
most twice), so it survives the service worker being stopped and restarted, which
is the reason it is not session-scoped. Removing the extension removes all of it.

**`tabs`**
Lists the open tabs so the user can choose which one the model operates, keeps
browser tools bound to that one tab, and opens a tab when the user asks for one.

**`scripting`**
Injects the page reader and the action executor into the selected tab. This is
how a page becomes text and how a click is delivered.

**`webNavigation`**
Detects when a navigation has finished, so the next read happens against the
settled page rather than a half-loaded one late in a redirect chain.

**`alarms`**
Keeps the connection to the desktop app alive across service-worker suspensions.
Manifest V3 workers are stopped when idle; the alarm is what wakes this one to
reconnect.

**`notifications`**
Raises an approval request when no side panel is open, so a pending decision is
not lost. If notifications are denied, the panel is opened instead.

## Host permissions

**`http://*/*` and `https://*/*`**

The extension operates **the page the user is looking at**, and that page is not
known when the manifest is written — the user may be on any site. There is no
narrower pattern that would work: a fixed list of domains would break the feature
for every site not on it.

What limits this in practice:

- The content script only **reads and acts on the tab the user explicitly
  selects**. It does not run tools against other tabs.
- Reading and acting are **separate operations**. Acting is approval-gated *while the
  approval switch is on*; that switch ships on, so a new install does not prompt before
  a click or a keystroke, and turning it off restores the prompts.
- Passwords and payment-card values are **replaced in place** and never leave the
  page.
- Page text is treated as **untrusted input** and labelled as such before it
  reaches the model, so a page cannot issue instructions that look like the
  user's.

**`ws://127.0.0.1:*` / `http://127.0.0.1:*` / `https:` / `http:` (declared in the CSP `connect-src`)**

The loopback entries carry the connection to the dsh desktop app on the same
machine. `https:` and `http:` cover **two** outbound operations, both of them about
image recognition, which is **off by default**:

1. **Fetching the image the user asked about** — the extension requests that
   image's own address from the page the user is already reading, carrying the
   user's cookies, which the desktop app cannot do. The bytes go over the loopback
   socket to the desktop app, which forwards them to the model the user configured.
   This is why the desktop relay depends on the extension rather than the reverse:
   when the extension's own fetch fails (a host it cannot reach, a body over the
   size budget), it sends the image's **address** instead and the desktop fetches
   it without the user's browser session.
2. **Calling the recognition API directly** — if the deployment configured the
   extension with its own endpoint, model and key (`visionEndpoint` /
   `visionModel` / `visionApiKey` in extension storage; the panel deliberately
   exposes no field for them), the extension itself POSTs the image to that
   endpoint instead of relaying through the desktop. That address is whatever the
   deployment set — typically a model provider — and the request carries the
   configured key. When no such endpoint is configured, this path is never taken.
   A description the extension already produced is reused from a local 24-hour
   memo, so asking about the same image twice does not repeat either operation.

Nothing else in the extension opens a remote connection. The
`raw.githubusercontent.com` entry that upstream carried was removed because no code
used it.

## Data usage disclosure

The store's data-usage form asks what is collected. Answer as follows:

- **Personally identifiable information** — not collected by this extension. The
  desktop app is a separate program the user runs; see its documentation.
- **Authentication information** — not collected. The bridge token is generated
  by the desktop app and stored locally by the browser.
- **Web history** — not collected.
- **Website content** — **read**, at the user's direction, and sent to the model
  the user has configured. This is the extension's function. Images count as website
  content: with image recognition switched on — it is off by default — the extension
  fetches the address of the image the user asked about, carrying the user's cookies,
  and hands the bytes to the desktop app exactly as it hands over page text (or the
  address alone, when its own fetch fails). If the deployment instead configured the
  extension with its own recognition endpoint and key, the image goes straight to
  that endpoint from the browser.
- **User activity** — not collected by the extension.
- **Location** — not collected.

Certify all three of the store's required statements: the data is not sold, is
not used for purposes unrelated to the single purpose, and is not used to
determine creditworthiness or for lending.
