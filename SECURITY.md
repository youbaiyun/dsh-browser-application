# Security

## Reporting a vulnerability

Open a [private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
rather than a public issue. If that is unavailable, open an issue that says only
that you have a security report and how to reach you — do not put the details in
it.

Please include what an attacker gains, what they need in order to do it, and the
version you tested. A proof of concept is welcome but not required.

## What this software can do, so you can judge a report

Worth stating plainly, because the answer decides whether something is a
vulnerability or the intended design:

- **It reads and operates the tab you point it at**, using your existing browser
  session. That is the feature, not a flaw.
- **Page text is untrusted input.** It is wrapped and labelled as such before it
  reaches the model. A page that tries to issue instructions is expected and
  handled; a page that *succeeds* is a vulnerability worth reporting.
- **Passwords and payment-card values never leave the page.** They are replaced
  in the snapshot before it is sent. If you find a field that is not masked,
  that is a bug and a serious one.
- **Text typed in the panel carries an origin marker.** The model distinguishes
  it from page content. If you find a route into a prompt that bypasses the
  marker, that defeats the mechanism entirely.
- **Clicking, typing, navigating, and tab management fail closed**, awaiting
  approval unless you have enabled unrestricted control for that connection.
- **The bridge listens on loopback only** and authenticates with a bearer token.
  A non-loopback caller is rejected, and privileged gateway methods are refused
  for non-loopback sources.
- **No screenshots are taken, ever.** The page channel is text by construction.

## Out of scope

- The model acting on page content in a way you dislike. The mechanism is that
  page content is untrusted; the judgement is the model's.
- Prompt injection that requires the attacker to already control what you type.
- Anything that needs an extension the user installed themselves to have already
  been compromised.
- The two known test limitations described in [CHANGELOG.md](CHANGELOG.md) under
  "Known issues" — those are platform constraints, not vulnerabilities.

## Supported versions

This fork ships as a single line. Fixes land on `main`; there are no maintained
older branches. If you are running a build older than the latest release, the
first step is to update.
