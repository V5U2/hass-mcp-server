import { describe, it, expect, vi, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RestClient } from "../ha/rest-client.js";
import type { WsClient } from "../ha/ws-client.js";
import type { HaSftpClient } from "../ha/sftp-client.js";
import { registerDashboardTools } from "../tools/dashboards.js";
import { registerFileTools } from "../tools/files.js";
import {
  registerAutomationTools,
  registerScriptTools,
  registerSceneTools,
  registerHelperTools,
} from "../tools/automations.js";
import { registerAddonTools, registerSystemTools } from "../tools/addons.js";
import { registerEntityTools } from "../tools/entities.js";
import { registerEnergyTools } from "../tools/energy.js";

describe("MCP tool registration smoke test", () => {
  let server: McpServer;
  let registerSpy: ReturnType<typeof vi.spyOn>;

  const mockRest = {} as RestClient;
  const mockWs = {} as WsClient;
  const mockSftp = {} as HaSftpClient;

  beforeAll(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerSpy = vi.spyOn(server, "registerTool");

    registerDashboardTools(server, mockWs);
    registerFileTools(server, mockSftp);
    registerAutomationTools(server, mockRest);
    registerScriptTools(server, mockRest);
    registerSceneTools(server, mockRest);
    registerHelperTools(server, mockWs);
    registerAddonTools(server, mockRest);
    registerSystemTools(server, mockRest, mockWs);
    registerEntityTools(server, mockRest, mockWs);
    registerEnergyTools(server, mockRest, mockWs);
  });

  it("registers exactly 68 tools", () => {
    expect(registerSpy).toHaveBeenCalledTimes(68);
  });

  it("every tool has a unique name", () => {
    const names = registerSpy.mock.calls.map((call: unknown[]) => call[0] as string);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("every tool has a description", () => {
    for (const call of registerSpy.mock.calls as unknown[][]) {
      const name = call[0] as string;
      const opts = call[1] as { description?: string };
      expect(opts.description, `tool '${name}' missing description`).toBeTruthy();
    }
  });

  it("all tool names follow the ha_ prefix convention", () => {
    const names = registerSpy.mock.calls.map((call: unknown[]) => call[0] as string);
    for (const name of names) {
      expect(name).toMatch(/^ha_/);
    }
  });

  it("registers expected tool categories", () => {
    const names = registerSpy.mock.calls.map((call: unknown[]) => call[0] as string);
    // Spot-check one tool from each registration group
    expect(names).toContain("ha_list_dashboards");
    expect(names).toContain("ha_list_files");
    expect(names).toContain("ha_list_automations");
    expect(names).toContain("ha_list_scripts");
    expect(names).toContain("ha_list_scenes");
    expect(names).toContain("ha_list_helpers");
    expect(names).toContain("ha_list_addons");
    expect(names).toContain("ha_system_info");
    expect(names).toContain("ha_get_states");
    expect(names).toContain("ha_get_energy_prefs");
    expect(names).toContain("ha_replace_grid_export_statistic");
  });
});
