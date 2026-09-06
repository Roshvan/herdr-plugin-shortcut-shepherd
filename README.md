# Shortcut Shepherd

One of the first things my first mentors had me install was [Key Promoter X](https://github.com/halirutan/IntelliJ-Key-Promoter-X) in IntelliJ. It helped me learn the keybindings and build muscle memory as I worked.

I wanted to bring that same experience to [Herdr](https://herdr.dev) as we get used to it here. That's why I built Shortcut Shepherd.

## Install

Requires Herdr 0.8.0+, Node.js 22.18+, and pnpm 11.25+.

```sh
herdr plugin install roshvan/herdr-plugin-shortcut-shepherd
```

Herdr installs the plugin's dependencies for you.

## Use

With Herdr running, start the watcher and open your shortcut stats:

```sh
herdr plugin action invoke roshvan.shortcut-shepherd.start
herdr plugin action invoke roshvan.shortcut-shepherd.stats
```

Use the arrow keys to browse and `q` to close.

To enable reminders on a local Mac, set `inputMonitoring` to `local-estimate` in the plugin's `config.json`. Find its directory with:

```sh
herdr plugin config-dir roshvan.shortcut-shepherd
```
