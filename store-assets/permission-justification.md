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
sharing mode, tab-switch behaviour, whether the model may open pages). Settings
survive a browser restart; nothing else is stored.

**`tabs`**
Lists the open tabs so the user can choose which one the model operates, keeps
browser tools bound to that one tab, and opens a tab when the user asks for one.

**`activeTab`**
Reads the tab the user has pointed the assistant at. Access is to that tab only,
and only after the user acts.

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
- Reading and acting are **separate, approval-gated operations** by default. The
  user is asked before anything is clicked or typed.
- Passwords and payment-card values are **replaced in place** and never leave the
  page.
- Page text is treated as **untrusted input** and labelled as such before it
  reaches the model, so a page cannot issue instructions that look like the
  user's.

**`ws://127.0.0.1:*` / `http://127.0.0.1:*` (declared in the CSP `connect-src`)**

The extension connects only to the dsh desktop app on the same machine, over
loopback. It contacts no remote server. The `raw.githubusercontent.com` entry
that upstream carried was removed because no code used it.

## Data usage disclosure

The store's data-usage form asks what is collected. Answer as follows:

- **Personally identifiable information** — not collected by this extension. The
  desktop app is a separate program the user runs; see its documentation.
- **Authentication information** — not collected. The bridge token is generated
  by the desktop app and stored locally by the browser.
- **Web history** — not collected.
- **Website content** — **read**, at the user's direction, and sent to the model
  the user has configured. This is the extension's function.
- **User activity** — not collected by the extension.
- **Location** — not collected.

Certify all three of the store's required statements: the data is not sold, is
not used for purposes unrelated to the single purpose, and is not used to
determine creditworthiness or for lending.
