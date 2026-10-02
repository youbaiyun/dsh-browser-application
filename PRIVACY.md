# Privacy policy

**dsh Browser Hand & Eye** — a browser extension for Chrome and Firefox.

Last updated: 2026-10-03

## Summary

This extension does not collect anything. It has no server of its own, no
analytics, and no telemetry. It talks to one place: the dsh desktop application
running on your own computer, over a loopback connection that does not leave your
machine.

## What the extension sends, and where

**It sends page content to the desktop app you are running.** That is its
purpose. When you ask the assistant to read or operate a page, the extension
extracts text from that page and hands it to the dsh application over
`127.0.0.1`. The dsh application then sends it to whichever AI model you have
configured there. **This extension does not choose that model and cannot see the
result of that decision.** What happens to the text after the desktop app
receives it is governed by the desktop app and by your model provider's terms,
not by this extension.

**No page content is sent anywhere else.** The extension's network access is
restricted by its own content security policy to `127.0.0.1`. It contacts no
remote server, including none belonging to the author of this extension.

## What is stored locally

The extension stores the following in your browser's extension storage, on your
machine only:

- The address and, where required, the token used to reach the desktop app.
- Your preferences: what page content may be shared and when, how tab switching
  is handled, whether the model may open pages on its own, and whether this panel
  should open automatically.

This data is not transmitted anywhere. Removing the extension removes it.

## What is never sent

- **Passwords and payment-card values.** Fields the page marks as sensitive are
  replaced with a placeholder before the snapshot leaves the page. They are not
  transmitted, in readable or encoded form.
- **Screenshots.** The extension never captures one.
- **Browsing history.** It reads the page you are on when you ask it to, and does
  not record where you have been.
- **Anything about you.** No name, no email, no account identifier, no
  advertising identifier, no telemetry, no crash reports.

## Page content is treated as untrusted

Text taken from a web page may contain sentences written to look like
instructions from you. The extension labels what you type in its panel with a
marker, and page text without it, so the model can tell the two apart. This is a
structural measure, not a filter: it does not depend on the page's content being
recognisable as an attack.

## Third parties

None. This extension has no third-party analytics, no advertising, and no
external services. It bundles two open-source libraries for rendering text in the
panel — Marked and DOMPurify — which run locally and send nothing.

## Children

This extension is a developer tool and is not directed at children. It collects
no personal information from anyone, including children.

## Your control

- Removing the extension deletes everything it has stored.
- Revoking the desktop app's connection (quitting dsh) stops all transfer.
- Turning page sharing to "Never" in the extension's settings stops page content
  from being read at all.

## Changes

Any change to this policy will be a new revision in this file's history, with the
date above updated.

## Contact

Open an issue on the project's repository.
