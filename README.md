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

The watcher starts with Herdr. You can also start it explicitly and open your shortcut stats:

```sh
herdr plugin action invoke roshvan.shortcut-shepherd.start
herdr plugin action invoke roshvan.shortcut-shepherd.stats
```

Use the arrow keys to browse and `q` to close.

Find the plugin's `config.json` with:

```sh
herdr plugin config-dir roshvan.shortcut-shepherd
```

The safe defaults record actions without reminders when their input source is unknown. A local Mac can estimate mouse versus keyboard activity:

```json
{
  "inputMonitoring": "local-estimate"
}
```

Herdr's lifecycle API does not report whether an action came from a mouse, shortcut, remote client, or automation. To receive sparse reminders anyway—including on Linux, Windows, and remote servers—explicitly opt in:

```json
{
  "unattributedActions": "remind"
}
```

This mode may remind you after an action that you already performed with its shortcut. Use `"record-only"` to disable those unattributed reminders.
