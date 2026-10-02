# Notes

These are architecture notes from
[Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser), kept because they
explain why the bridge is built the way it is — the split between the npm
workspace, the profile bundle and the installer, and why the extension probes for
a bridge before opening a socket. Deleting them would remove the reasoning and
leave only the result.

They describe upstream's arrangement, from upstream's point of view, and a fork
changes some of what they name. Most visibly:

- Repository and package names here are `dsh-browser-application`; the notes refer
  to upstream's.
- The extension's panel is not the one described. Upstream's is a React
  application; this fork replaces it with a small side panel, so any note
  reasoning about the panel's behaviour applies to upstream's, not this one's.
- The managed install directory is still `~/.dsh/dsh-browser`, as these notes
  say. It was deliberately **not** renamed with the project: an existing
  installation lives there, and a new directory would orphan it. The installers
  are the authority on this; they agree with each other.

Read them for the decisions, not for the paths. Where a decision and this
repository disagree, this repository is current and
[CHANGELOG.md](../../CHANGELOG.md) records the divergence.
