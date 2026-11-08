import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RestClient } from "../ha/rest-client.js";
import type { WsClient } from "../ha/ws-client.js";
import { fingerprintPrefs } from "../energy/grid-export.js";
import { registerEnergyTools, replaceGridExport } from "../tools/energy.js";

function mockRest(version = "2026.5.1"): RestClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/api/config") return { version };
      throw new Error(`unexpected REST ${path}`);
    }),
    post: vi.fn(),
    delete: vi.fn(),
  } as unknown as RestClient;
}

function mockWs(): WsClient & { sendCommand: ReturnType<typeof vi.fn> } {
  return { sendCommand: vi.fn() } as unknown as WsClient & {
    sendCommand: ReturnType<typeof vi.fn>;
  };
}

function prefs() {
  return {
    energy_sources: [
      {
        type: "grid",
        stat_energy_from: "sensor.grid_import",
        stat_energy_to: "sensor.grid_export_old",
        number_energy_price: 0.2,
        entity_energy_price_export: "sensor.export_tariff",
        future_field: { ok: true },
        cost_adjustment_day: 0,
      },
      { type: "solar", stat_energy_from: "sensor.roof", future_solar: 1 },
    ],
    device_consumption: [{ stat_consumption: "sensor.oven", name: "Oven" }],
    device_consumption_water: [],
    site_note: "keep-me",
  };
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("replaceGridExport", () => {
  let rest: RestClient;
  let ws: ReturnType<typeof mockWs>;
  let current: ReturnType<typeof prefs>;

  beforeEach(() => {
    current = prefs();
    rest = mockRest();
    ws = mockWs();
    ws.sendCommand.mockImplementation(
      async (type: string, payload?: { energy_sources?: unknown[] }) => {
        if (type === "energy/get_prefs") return structuredClone(current);
        if (type === "energy/save_prefs") {
          current = {
            ...current,
            energy_sources: payload?.energy_sources as typeof current.energy_sources,
          };
          return current;
        }
        if (type === "energy/validate") return { energy_sources: [[]], device_consumption: [[]] };
        throw new Error(`unexpected ${type}`);
      },
    );
  });

  it("saves only energy_sources, preserves other fields, and reports a one-path diff", async () => {
    const fingerprint = fingerprintPrefs(current);
    const report = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprint,
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(report.success).toBe(true);
    expect(report.outcome).toBe("persisted");
    expect(report.persistence).toBe("saved");
    expect(report.readback).toBe("matched");
    expect(report.post_save_validation).toBe("returned");
    expect(report.diff_since_read).toEqual([
      {
        path: "$.energy_sources[0].stat_energy_to",
        before: "sensor.grid_export_old",
        after: "sensor.grid_export_new",
      },
    ]);
    const save = ws.sendCommand.mock.calls.find((call) => call[0] === "energy/save_prefs");
    expect(save?.[1]).toEqual({
      energy_sources: [
        expect.objectContaining({
          stat_energy_to: "sensor.grid_export_new",
          entity_energy_price_export: "sensor.export_tariff",
          future_field: { ok: true },
          number_energy_price: 0.2,
        }),
        expect.objectContaining({ type: "solar", future_solar: 1 }),
      ],
    });
    expect(Object.keys(save?.[1] as object)).toEqual(["energy_sources"]);
    expect(ws.sendCommand.mock.calls.map((call) => call[0])).toEqual([
      "energy/get_prefs",
      "energy/get_prefs",
      "energy/save_prefs",
      "energy/get_prefs",
      "energy/validate",
    ]);
  });

  it("does not save when the fingerprint is stale", async () => {
    const report = await replaceGridExport(rest, ws, {
      expectedFingerprint: "a".repeat(64),
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(report.outcome).toBe("stale_fingerprint");
    expect(report.persistence).toBe("not_attempted");
    expect(ws.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("does not save when the confirming read changes", async () => {
    const fingerprint = fingerprintPrefs(current);
    let reads = 0;
    ws.sendCommand.mockImplementation(async (type: string) => {
      if (type === "energy/get_prefs") {
        reads += 1;
        if (reads === 1) return structuredClone(current);
        const changed = structuredClone(current);
        changed.device_consumption[0].name = "Changed by someone else";
        return changed;
      }
      throw new Error(`unexpected ${type}`);
    });
    const report = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprint,
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(report.outcome).toBe("stale_fingerprint");
    expect(report.persistence).toBe("not_attempted");
    expect(ws.sendCommand.mock.calls.map((call) => call[0])).toEqual([
      "energy/get_prefs",
      "energy/get_prefs",
    ]);
  });

  it("reports an administrator rejection without a second write", async () => {
    const fingerprint = fingerprintPrefs(current);
    ws.sendCommand.mockImplementation(async (type: string) => {
      if (type === "energy/get_prefs") return structuredClone(current);
      if (type === "energy/save_prefs") {
        throw new Error("HA WS error (unauthorized): admin required");
      }
      throw new Error(`unexpected ${type}`);
    });
    const report = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprint,
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(report.outcome).toBe("auth_failed");
    expect(report.persistence).toBe("failed");
    expect(report.readback).toBe("not_attempted");
    expect(
      ws.sendCommand.mock.calls.filter((call) => call[0] === "energy/save_prefs"),
    ).toHaveLength(1);
    expect(ws.sendCommand.mock.calls.some((call) => call[0] === "energy/validate")).toBe(false);
  });

  it("reports a missing match and an ambiguous match without saving", async () => {
    const fingerprint = fingerprintPrefs(current);
    const missing = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprint,
      oldStatistic: "sensor.not_configured",
      newStatistic: "sensor.grid_export_new",
    });
    expect(missing.outcome).toBe("not_found");
    expect(ws.sendCommand.mock.calls.some((call) => call[0] === "energy/save_prefs")).toBe(false);

    current.energy_sources.push({
      ...current.energy_sources[0],
      stat_energy_from: "sensor.other_import",
    });
    const ambiguous = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprintPrefs(current),
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(ambiguous.outcome).toBe("ambiguous");
    expect(ws.sendCommand.mock.calls.some((call) => call[0] === "energy/save_prefs")).toBe(false);
  });

  it("keeps a saved result when the readback differs and does not write again", async () => {
    const fingerprint = fingerprintPrefs(current);
    let reads = 0;
    ws.sendCommand.mockImplementation(
      async (type: string, payload?: { energy_sources?: unknown[] }) => {
        if (type === "energy/get_prefs") {
          reads += 1;
          if (reads < 3) return structuredClone(current);
          const drifted = structuredClone(current);
          drifted.energy_sources = payload
            ? (current.energy_sources as never)
            : drifted.energy_sources;
          drifted.energy_sources = structuredClone(current.energy_sources);
          drifted.energy_sources[0].stat_energy_to = "sensor.grid_export_new";
          drifted.energy_sources[0].number_energy_price = 9;
          return drifted;
        }
        if (type === "energy/save_prefs") return null;
        if (type === "energy/validate") return { raw: true };
        throw new Error(`unexpected ${type}`);
      },
    );
    const report = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprint,
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(report.persistence).toBe("saved");
    expect(report.readback).toBe("mismatch");
    expect(report.outcome).toBe("persisted_readback_mismatch");
    expect(report.success).toBe(false);
    expect(report.diff_from_intended).toEqual([
      {
        path: "$.energy_sources[0].number_energy_price",
        before: 0.2,
        after: 9,
      },
    ]);
    expect(
      ws.sendCommand.mock.calls.filter((call) => call[0] === "energy/save_prefs"),
    ).toHaveLength(1);
  });

  it("distinguishes a readback transport failure from a validation failure", async () => {
    const fingerprint = fingerprintPrefs(current);
    let reads = 0;
    ws.sendCommand.mockImplementation(async (type: string) => {
      if (type === "energy/get_prefs") {
        reads += 1;
        if (reads < 3) return structuredClone(current);
        throw new Error("HA WS error (unknown_error): socket dropped");
      }
      if (type === "energy/save_prefs") return null;
      throw new Error(`unexpected ${type}`);
    });
    const readbackFailed = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprint,
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(readbackFailed.persistence).toBe("saved");
    expect(readbackFailed.readback).toBe("failed");
    expect(readbackFailed.post_save_validation).toBe("not_attempted");
    expect(readbackFailed.outcome).toBe("persisted_readback_failed");

    reads = 0;
    ws.sendCommand.mockImplementation(
      async (type: string, payload?: { energy_sources?: unknown[] }) => {
        if (type === "energy/get_prefs") return structuredClone(current);
        if (type === "energy/save_prefs") {
          current = {
            ...current,
            energy_sources: payload?.energy_sources as typeof current.energy_sources,
          };
          return null;
        }
        if (type === "energy/validate")
          throw new Error("HA WS error (unknown_error): validate down");
        throw new Error(`unexpected ${type}`);
      },
    );
    const validationFailed = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprintPrefs(prefs()),
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(validationFailed.persistence).toBe("saved");
    expect(validationFailed.readback).toBe("matched");
    expect(validationFailed.post_save_validation).toBe("failed");
    expect(validationFailed.outcome).toBe("persisted_validation_unavailable");
    expect(validationFailed.success).toBe(false);
  });

  it("refuses a unified document on a pre-2026.5 core without saving", async () => {
    rest = mockRest("2026.4.0");
    const report = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprintPrefs(current),
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(report.outcome).toBe("unsupported_version");
    expect(report.persistence).toBe("not_attempted");
    expect(ws.sendCommand.mock.calls.some((call) => call[0] === "energy/save_prefs")).toBe(false);
  });

  it("refuses an unreadable version and an unauthorized config read before websocket", async () => {
    rest = mockRest("not-a-version");
    const unreadable = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprintPrefs(current),
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(unreadable.outcome).toBe("unsupported_version");
    expect(ws.sendCommand).not.toHaveBeenCalled();

    vi.mocked(rest.get).mockRejectedValue(
      new Error("HA REST GET /api/config failed (401): denied"),
    );
    const unauthorized = await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprintPrefs(current),
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(unauthorized.outcome).toBe("auth_failed");
    expect(unauthorized.persistence).toBe("not_attempted");
    expect(ws.sendCommand).not.toHaveBeenCalled();
  });

  it("does not touch a second instance's client", async () => {
    const otherRest = mockRest();
    const otherWs = mockWs();
    await replaceGridExport(rest, ws, {
      expectedFingerprint: fingerprintPrefs(current),
      oldStatistic: "sensor.grid_export_old",
      newStatistic: "sensor.grid_export_new",
    });
    expect(otherRest.get).not.toHaveBeenCalled();
    expect(otherWs.sendCommand).not.toHaveBeenCalled();
  });
});

describe("registerEnergyTools", () => {
  it("keeps the two tools on the clients they were given", async () => {
    const restA = mockRest("2026.5.0");
    const wsA = mockWs();
    const restB = mockRest("2025.12.0");
    const wsB = mockWs();
    wsA.sendCommand.mockResolvedValue(prefs());
    wsB.sendCommand.mockResolvedValue({ energy_sources: [] });

    const serverA = new McpServer({ name: "a", version: "0.0.0" });
    const serverB = new McpServer({ name: "b", version: "0.0.0" });
    const spyA = vi.spyOn(serverA, "registerTool");
    const spyB = vi.spyOn(serverB, "registerTool");
    registerEnergyTools(serverA, restA, wsA);
    registerEnergyTools(serverB, restB, wsB);
    const readA = spyA.mock.calls.find(
      (call) => call[0] === "ha_get_energy_prefs",
    )?.[2] as unknown as () => Promise<{
      content: Array<{ text: string }>;
    }>;
    const readB = spyB.mock.calls.find(
      (call) => call[0] === "ha_get_energy_prefs",
    )?.[2] as unknown as () => Promise<{
      content: Array<{ text: string }>;
    }>;
    const bodyA = parse(await readA());
    const bodyB = parse(await readB());
    expect(bodyA.ha_version).toBe("2026.5.0");
    expect(bodyB.ha_version).toBe("2025.12.0");
    expect(bodyA.fingerprint).not.toBe(bodyB.fingerprint);
    expect(wsA.sendCommand).toHaveBeenCalledWith("energy/get_prefs");
    expect(wsB.sendCommand).toHaveBeenCalledWith("energy/get_prefs");
    expect(restA.get).toHaveBeenCalledWith("/api/config");
    expect(restB.get).toHaveBeenCalledWith("/api/config");
  });
});
