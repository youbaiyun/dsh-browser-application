# Copyright and licensing

This project is a derivative work. Two sets of rights apply, and this file says
which is which so nobody has to guess.

## Upstream: the browser engine

The following come from [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser)
and remain under its MIT license:

- `packages/bridge/` — the bridge plugin
- `extension/src/content/` — the page snapshot and action pipeline
- `extension/src/security/` — the approval and trust model
- `extension/src/background/` — except `session.ts`
- `benchmark/` — the evaluation harness

At the fork point these were 78 byte-identical files and about 90% of upstream's
lines, which is why the notice below has to be preserved. That is a condition of
the license the code was received under, not a courtesy.

    MIT License

    Copyright (c) 2026 Yuxiang Lin

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## This fork: the interaction layer

Copyright (c) 2026 youbaiyun. Also MIT, on the same terms as above.

The files this fork is responsible for, none of which come from upstream:

- `extension/control/` — the side-panel UI (replaces the React panel)
- `extension/src/settings.ts` — the settings model
- `extension/src/background/session.ts` — panel-to-conversation binding
- `skills/dsh-browser-crossplatform-troubleshooting/` — the troubleshooting skill
- the panel's own tests, and the layout/measurement scripts under `scripts/`

## Removed on purpose

`.github/FUNDING.yml` was deleted. It named the upstream maintainer's sponsorship
account, which would have collected donations intended for this fork.

## Contributions upstream

Engine defects belong in the upstream issue tracker, because the code in question
is theirs. Panel and interaction defects belong here.
