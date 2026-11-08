import { describe, expect, it } from "vitest";
import {
  fingerprintPrefs,
  parseHaVersion,
  planGridExportReplacement,
  semanticDiff,
  type HaVersion,
} from "../energy/grid-export.js";

const unifiedVersion = parseHaVersion("2026.5.0") as HaVersion;
const legacyVersion = parseHaVersion("2026.4.4") as HaVersion;

function unifiedPrefs() {
  return {
    device_consumption_water: [{ stat_consumption: "sensor.irrigation", name: "Garden" }],
    device_consumption: [{ stat_consumption: "sensor.oven", extra: true }],
    future_top: { keep: "yes" },
    energy_sources: [
      {
        type: "solar",
        stat_energy_from: "sensor.solar",
        name: "Roof",
      },
      {
        type: "grid",
        stat_energy_from: "sensor.grid_import",
        stat_energy_to: "sensor.grid_export_old",
        stat_cost: "sensor.import_cost",
        entity_energy_price: null,
        number_energy_price: 0.25,
        stat_compensation: null,
        entity_energy_price_export: "sensor.export_price",
        number_energy_price_export: null,
        cost_adjustment_day: 0,
        future_field: { nested: true },
      },
      {
        type: "battery",
        stat_energy_from: "sensor.battery_out",
        stat_energy_to: "sensor.battery_in",
        name: "Pack",
      },
    ],
  };
}

function legacyPrefs() {
  return {
    energy_sources: [
      {
        type: "grid",
        cost_adjustment_day: 0,
        flow_from: [
          {
            stat_energy_from: "sensor.grid_import",
            stat_cost: "sensor.import_cost",
            number_energy_price: 0.3,
          },
        ],
        flow_to: [
          {
            stat_energy_to: "sensor.grid_export_old",
            stat_compensation: "sensor.export_credit",
            future_flow: "keep",
          },
        ],
        power: [{ stat_rate: "sensor.grid_power" }],
      },
    ],
    device_consumption: [],
  };
}

describe("planGridExportReplacement", () => {
  it("replaces only the unified grid export and keeps unknown fields", () => {
    const prefs = unifiedPrefs();
    const plan = planGridExportReplacement(
      prefs,
      "sensor.grid_export_old",
      "sensor.grid_export_new",
      unifiedVersion,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.schema).toBe("unified");
    expect(plan.matchPath).toBe("energy_sources[1].stat_energy_to");
    const sources = plan.energySources as Array<Record<string, unknown>>;
    expect(sources[1].stat_energy_to).toBe("sensor.grid_export_new");
    expect(sources[1].future_field).toEqual({ nested: true });
    expect(sources[1].entity_energy_price_export).toBe("sensor.export_price");
    expect(sources[1].number_energy_price).toBe(0.25);
    expect(sources[0]).toEqual(prefs.energy_sources[0]);
    expect(sources[2]).toEqual(prefs.energy_sources[2]);
    expect(prefs.energy_sources[1].stat_energy_to).toBe("sensor.grid_export_old");
  });

  it("replaces only the legacy flow_to export", () => {
    const prefs = legacyPrefs();
    const plan = planGridExportReplacement(
      prefs,
      "sensor.grid_export_old",
      "sensor.grid_export_new",
      legacyVersion,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.schema).toBe("legacy_flow");
    expect(plan.matchPath).toBe("energy_sources[0].flow_to[0].stat_energy_to");
    const source = plan.energySources[0] as {
      flow_from: unknown[];
      flow_to: Array<Record<string, unknown>>;
      power: unknown[];
    };
    expect(source.flow_to[0].stat_energy_to).toBe("sensor.grid_export_new");
    expect(source.flow_to[0].future_flow).toBe("keep");
    expect(source.flow_to[0].stat_compensation).toBe("sensor.export_credit");
    expect(source.flow_from).toEqual(prefs.energy_sources[0].flow_from);
    expect(source.power).toEqual(prefs.energy_sources[0].power);
  });

  it("refuses a unified document before the published 2026.5 pin", () => {
    const plan = planGridExportReplacement(
      unifiedPrefs(),
      "sensor.grid_export_old",
      "sensor.grid_export_new",
      legacyVersion,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.outcome).toBe("unsupported_version");
  });

  it("refuses a legacy document on the unified pin", () => {
    const plan = planGridExportReplacement(
      legacyPrefs(),
      "sensor.grid_export_old",
      "sensor.grid_export_new",
      unifiedVersion,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.outcome).toBe("unsupported_version");
  });

  it("refuses a grid that mixes flow arrays with flat statistics", () => {
    const prefs = unifiedPrefs();
    (prefs.energy_sources[1] as { flow_to?: unknown[] }).flow_to = [
      { stat_energy_to: "sensor.grid_export_old" },
    ];
    const plan = planGridExportReplacement(
      prefs,
      "sensor.grid_export_old",
      "sensor.grid_export_new",
      unifiedVersion,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.outcome).toBe("unsupported_schema");
  });

  it("refuses two grid exports with the same statistic", () => {
    const prefs = unifiedPrefs();
    prefs.energy_sources.push({
      ...prefs.energy_sources[1],
      stat_energy_from: "sensor.other_import",
    });
    const plan = planGridExportReplacement(
      prefs,
      "sensor.grid_export_old",
      "sensor.grid_export_new",
      unifiedVersion,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.outcome).toBe("ambiguous");
  });

  it("does not treat an import or battery statistic as the grid export", () => {
    const missingImport = planGridExportReplacement(
      unifiedPrefs(),
      "sensor.grid_import",
      "sensor.grid_export_new",
      unifiedVersion,
    );
    const missingBattery = planGridExportReplacement(
      unifiedPrefs(),
      "sensor.battery_in",
      "sensor.grid_export_new",
      unifiedVersion,
    );
    expect(missingImport.ok).toBe(false);
    expect(missingBattery.ok).toBe(false);
    if (missingImport.ok || missingBattery.ok) return;
    expect(missingImport.outcome).toBe("not_found");
    expect(missingBattery.outcome).toBe("not_found");
  });

  it("rejects an unparseable version and a non-entity statistic id", () => {
    expect(parseHaVersion("core-2026")).toBeNull();
    expect(parseHaVersion("2026.13.0")).toBeNull();
    const plan = planGridExportReplacement(
      unifiedPrefs(),
      "sensor.grid_export_old",
      "not a statistic",
      unifiedVersion,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.outcome).toBe("invalid_statistic");
  });
});

describe("fingerprint and diff", () => {
  it("is stable across key order and changes when a nested value changes", () => {
    const first = { b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } };
    const reordered = { a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 };
    expect(fingerprintPrefs(first)).toBe(fingerprintPrefs(reordered));
    const changed = { b: 1, a: { d: 2, c: [1, { z: 1, y: 3 }] } };
    expect(fingerprintPrefs(changed)).not.toBe(fingerprintPrefs(first));
  });

  it("reports one semantic path for the export change", () => {
    const before = unifiedPrefs();
    const after = unifiedPrefs();
    after.energy_sources[1].stat_energy_to = "sensor.grid_export_new";
    expect(semanticDiff(before, after)).toEqual([
      {
        path: "$.energy_sources[1].stat_energy_to",
        before: "sensor.grid_export_old",
        after: "sensor.grid_export_new",
      },
    ]);
  });
});
