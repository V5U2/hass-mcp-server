#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { RestClient } from "./ha/rest-client.js";
import { WsClient } from "./ha/ws-client.js";
import { HaSftpClient } from "./ha/sftp-client.js";
import { registerDashboardTools } from "./tools/dashboards.js";
import { registerFileTools } from "./tools/files.js";
import {
  registerAutomationTools,
  registerScriptTools,
  registerSceneTools,
  registerHelperTools,
} from "./tools/automations.js";
import { registerAddonTools, registerSystemTools } from "./tools/addons.js";
import { registerEntityTools } from "./tools/entities.js";
import { registerEnergyTools } from "./tools/energy.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Initialize clients
  const rest = new RestClient(config);
  const ws = new WsClient(config);
  const sftp = new HaSftpClient(config);

  // Create MCP server
  const server = new McpServer({
    name: "hass-mcp-server",
    version: "1.0.10",
  });

  // Register all tool groups
  registerDashboardTools(server, ws);
  registerFileTools(server, sftp);
  registerAutomationTools(server, rest);
  registerScriptTools(server, rest);
  registerSceneTools(server, rest);
  registerHelperTools(server, ws);
  registerAddonTools(server, rest);
  registerSystemTools(server, rest, ws);
  registerEntityTools(server, rest, ws);
  registerEnergyTools(server, rest, ws);

  // Handle graceful shutdown
  const cleanup = async () => {
    await ws.disconnect();
    await sftp.disconnect();
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  // Start the server on stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
