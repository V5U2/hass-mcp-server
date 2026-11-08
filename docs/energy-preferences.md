# Energy grid-export replacement

Version 1.1.0 adds two tools. They do not change a live Home Assistant instance by themselves. A person still has to run them against one site, with that site's existing process configuration.

This is **not** an official stable Home Assistant API. The [WebSocket API](https://developers.home-assistant.io/docs/api/websocket) contract does not list Energy preference commands, and the [REST API](https://developers.home-assistant.io/docs/api/rest) has no preference route. The implementation follows public third-party clients:

- [ha-mcp `ha_manage_energy_prefs`](https://homeassistant-ai.github.io/ha-mcp/tools/) documents `energy/get_prefs`, `energy/save_prefs` (each supplied top-level list replaces that list; omitted keys stay), an administrator token, and a later `energy/validate` that does not undo the save.
- ha-mcp 8.6.0's published grid field set included `stat_energy_to`. Version 8.7.0 (15 October 2026) stopped publishing that static list and tells callers to read the running Core instead. This server does not do that. It accepts only the two shapes below and refuses anything else.
- [ha-nexus `energy_add_grid_return`](https://glama.ai/mcp/servers/Fistacho/ha-nexus-agent/tools/energy_add_grid_return) documents `stat_energy_to` as the grid-export statistic on a legacy `flow_to` entry. The same field name on a battery source is charge, not grid export, and is never edited here.
- [Core PR 162200](https://github.com/home-assistant/core/pull/162200) (merged 16 February 2026) describes moving `flow_from` / `flow_to` / `power` arrays to one object per grid connection. It does not name a Core release. [homeassistant-mcp 0.2.0](https://github.com/OrellBuehler/homeassistant-mcp/releases/tag/v0.2.0) (7 June 2026) documents the unified model as Home Assistant 2026.5 or newer.

## What the tools will accept

| Observed grid shape                                                                                                   | Home Assistant version from `GET /api/config` |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Legacy grid object that has `flow_from`, `flow_to`, or `power`, and the export id lives on `flow_to[].stat_energy_to` | Before 2026.5                                 |
| Unified grid object whose export id is the top-level `stat_energy_to` string                                          | 2026.5 or newer                               |

A mixed document, a shape on the wrong side of that version pin, an unreadable version, more than one matching grid export, or no match is rejected before `energy/save_prefs`. Unknown fields on the matched object are copied. The save body contains only `energy_sources`.

`energy/validate` is called after a save that returned without error and after a readback was fetched. Its body is returned raw. Public client docs do not define a stable "no issues" schema, so a validation payload is not treated as a pass, a failure, or a reason to write again.

## Concurrency

The fingerprint is sha256 of a canonical JSON copy of the preferences document, computed in this process. Home Assistant does not enforce it. The tool reads, checks the fingerprint, reads once more, and only then saves. A writer that lands between the confirming read and `energy/save_prefs`, or after the readback, is not prevented. There is no automatic rollback, because a later write could overwrite someone else.

## Sites, headers, and TLS

Each process has one `HA_URL` and one `HA_TOKEN`. Forthav and Glenroyd stay isolated by running two processes. Do not put both tokens in one environment.

This package does not set Cloudflare Access headers, and it does not assume the upstream connector did. Keep using the same URL that already reaches that site. If a proxy in front of the process injects headers, that stays outside this repository.

`src/ha/ws-client.ts` still constructs the socket with `rejectUnauthorized: false`. This change does not weaken or repair that. The Energy tools use the same socket.

The save needs an administrator token. A non-admin token is reported as `auth_failed` and is not retried.

## Future HA-F call (not run here)

No household id is built into the package. When a person later approves the HA-F change, the call on the HA-F process only is:

1. `ha_get_energy_prefs`
2. `ha_replace_grid_export_statistic` with that response's `fingerprint`, `old_statistic` `sensor.goodwe_total_energy_export`, and `new_statistic` `sensor.goodwe_meter_total_energy_export`

Read `persistence`, `readback`, and `diff_since_read` before treating it as done. `persistence: saved` means the save command returned. `readback: matched` means the following read equals the intended one-field change. Those are different from `post_save_validation`.

## Pin and rollback

Reviewed artifact: git branch `cursor/energy-grid-export-347e` at the commit that adds version 1.1.0. Do not deploy from an unreviewed tree. This repository change does not publish npm and does not restart Home Assistant.

To take the tools back out of a process, run that process from commit `1ba71d8` (package 1.0.10) and restart only the MCP process. That does not undo a preference write that already persisted.

If a readback matched and a person later wants the previous statistic id, that is a new replacement with a fresh fingerprint and the ids swapped. If the readback mismatched, do not send another replacement until a person has compared `diff_from_intended`. Do not edit `.storage/energy`, and do not use these tools to roll back over a concurrent change.
