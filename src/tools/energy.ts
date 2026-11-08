import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RestClient } from "../ha/rest-client.js";
import type { WsClient } from "../ha/ws-client.js";
import {
  ENERGY_SUPPORT,
  fingerprintPrefs,
  isFingerprint,
  parseHaVersion,
  planGridExportReplacement,
  semanticDiff,
  type HaVersion,
} from "../energy/grid-export.js";

type Persistence = "not_attempted" | "saved" | "failed";
type Readback = "not_attempted" | "matched" | "mismatch" | "failed";
type Validation = "not_attempted" | "returned" | "failed";

interface Report {
  support: typeof ENERGY_SUPPORT;
  success: boolean;
  outcome: string;
  message: string;
  persistence: Persistence;
  readback: Readback;
  post_save_validation: Validation;
  ha_version: string | null;
  fingerprint: string | null;
  schema: string | null;
  match_path: string | null;
  diff_since_read: ReturnType<typeof semanticDiff>;
  diff_from_intended: ReturnType<typeof semanticDiff>;
  validation: unknown;
  preferences?: unknown;
}

/**
 * Read Energy preferences and replace one existing grid-export statistic.
 * Uses the process-wide RestClient and WsClient. One process has one HA_URL.
 */
export function registerEnergyTools(server: McpServer, rest: RestClient, ws: WsClient): void {
  server.registerTool(
    "ha_get_energy_prefs",
    {
      description:
        "Read Home Assistant Energy dashboard preferences and a sha256 fingerprint of that document. " +
        "Practice follows public third-party clients (ha-mcp energy/get_prefs). This is not a stable Home Assistant API. " +
        "Does not change preferences. The fingerprint is a client lock only.",
    },
    async () => {
      const report = await readReport(rest, ws);
      return json(report);
    },
  );

  server.registerTool(
    "ha_replace_grid_export_statistic",
    {
      description:
        "Replace one existing grid-export statistic on the Energy dashboard. Requires the fingerprint from ha_get_energy_prefs and the exact current statistic id. " +
        "Sends energy/save_prefs with only energy_sources, so other top-level keys stay untouched, and changes only the matched stat_energy_to. " +
        "Rejects a stale fingerprint, a missing match, more than one grid-export match, and a schema/version pair outside the published client bands " +
        "(legacy flow_to before HA 2026.5, unified grid object on HA 2026.5+). " +
        "Not a stable Home Assistant API. Replacements in this process are serialized and the later call re-reads; a stale fingerprint fails. " +
        "A writer outside this process is still not atomic. success is true only when the readback matches. " +
        "A validate error does not undo the save and does not retry it.",
      inputSchema: {
        expected_fingerprint: z
          .string()
          .describe(
            "sha256 hex fingerprint returned by ha_get_energy_prefs for this same process.",
          ),
        old_statistic: z
          .string()
          .describe(
            "Existing grid-export statistic id to replace, as domain.object_id. Not limited to one household.",
          ),
        new_statistic: z
          .string()
          .describe("Replacement grid-export statistic id, as domain.object_id."),
      },
    },
    async ({ expected_fingerprint, old_statistic, new_statistic }) => {
      const report = await replaceGridExport(rest, ws, {
        expectedFingerprint: expected_fingerprint,
        oldStatistic: old_statistic,
        newStatistic: new_statistic,
      });
      return json(report);
    },
  );
}

export async function readReport(rest: RestClient, ws: WsClient): Promise<Report> {
  const version = await readVersion(rest);
  if (!version.ok) {
    return baseReport(version.report);
  }
  const prefs = await readPrefs(ws);
  if (!prefs.ok) {
    return baseReport({ ...prefs.report, ha_version: version.version.raw });
  }
  return baseReport({
    outcome: "read",
    message:
      "Preferences were read. No save was sent. Pass fingerprint to ha_replace_grid_export_statistic on this same process only.",
    persistence: "not_attempted",
    ha_version: version.version.raw,
    fingerprint: fingerprintPrefs(prefs.prefs),
    preferences: prefs.prefs,
    success: true,
  });
}

let replacementQueue: Promise<void> = Promise.resolve();

/** One replacement at a time in this process. The waiter then reads current state itself. */
function enqueueReplacement<T>(work: () => Promise<T>): Promise<T> {
  const run = replacementQueue.then(work, work);
  replacementQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function replaceGridExport(
  rest: RestClient,
  ws: WsClient,
  input: { expectedFingerprint: string; oldStatistic: string; newStatistic: string },
): Promise<Report> {
  return enqueueReplacement(() => replaceGridExportUnlocked(rest, ws, input));
}

async function replaceGridExportUnlocked(
  rest: RestClient,
  ws: WsClient,
  input: { expectedFingerprint: string; oldStatistic: string; newStatistic: string },
): Promise<Report> {
  if (!isFingerprint(input.expectedFingerprint)) {
    return baseReport({
      outcome: "invalid_fingerprint",
      message: "expected_fingerprint must be the 64-character sha256 hex from ha_get_energy_prefs.",
    });
  }

  const version = await readVersion(rest);
  if (!version.ok) return baseReport(version.report);

  const first = await readPrefs(ws);
  if (!first.ok) return baseReport({ ...first.report, ha_version: version.version.raw });

  const firstFingerprint = fingerprintPrefs(first.prefs);
  if (firstFingerprint !== input.expectedFingerprint) {
    return baseReport({
      outcome: "stale_fingerprint",
      message:
        "Preferences no longer match expected_fingerprint. Nothing was written. Read again and retry only if the new document is the one you intend to edit.",
      ha_version: version.version.raw,
      fingerprint: firstFingerprint,
      preferences: first.prefs,
    });
  }

  const planned = applyPlan(first.prefs, input.oldStatistic, input.newStatistic, version.version);
  if (!planned.ok) {
    return baseReport({
      ...planned.report,
      ha_version: version.version.raw,
      fingerprint: firstFingerprint,
      preferences: first.prefs,
    });
  }

  const confirm = await readPrefs(ws);
  if (!confirm.ok) {
    return baseReport({
      ...confirm.report,
      ha_version: version.version.raw,
      fingerprint: firstFingerprint,
      message: `${confirm.report.message} The confirming read failed before save_prefs. Nothing was written.`,
    });
  }
  const confirmFingerprint = fingerprintPrefs(confirm.prefs);
  if (confirmFingerprint !== input.expectedFingerprint) {
    return baseReport({
      outcome: "stale_fingerprint",
      message:
        "Preferences changed after the first read and before save_prefs. Nothing was written.",
      ha_version: version.version.raw,
      fingerprint: confirmFingerprint,
      preferences: confirm.prefs,
    });
  }

  const confirmed = applyPlan(
    confirm.prefs,
    input.oldStatistic,
    input.newStatistic,
    version.version,
  );
  if (!confirmed.ok) {
    return baseReport({
      ...confirmed.report,
      ha_version: version.version.raw,
      fingerprint: confirmFingerprint,
      preferences: confirm.prefs,
    });
  }

  try {
    await ws.sendCommand("energy/save_prefs", { energy_sources: confirmed.energySources });
  } catch (err) {
    const kind = classifyError(err);
    return baseReport({
      outcome: kind === "auth" ? "auth_failed" : "persist_failed",
      message:
        kind === "auth"
          ? "Home Assistant rejected energy/save_prefs. An administrator token is required. Nothing further was written."
          : `energy/save_prefs failed before persistence could be confirmed: ${errorText(err)}`,
      persistence: "failed",
      ha_version: version.version.raw,
      fingerprint: confirmFingerprint,
      schema: confirmed.schema,
      match_path: confirmed.matchPath,
    });
  }

  const intended = intendedPrefs(confirm.prefs, confirmed.energySources);
  let readbackPrefs: unknown;
  try {
    const readback = await readPrefs(ws);
    if (!readback.ok) {
      return baseReport({
        outcome: "persisted_readback_failed",
        message:
          "energy/save_prefs returned without error, then the readback failed. Persistence is not re-checked and nothing else was written. Do not send a corrective write from this result.",
        persistence: "saved",
        readback: "failed",
        ha_version: version.version.raw,
        fingerprint: confirmFingerprint,
        schema: confirmed.schema,
        match_path: confirmed.matchPath,
      });
    }
    readbackPrefs = readback.prefs;
  } catch (err) {
    return baseReport({
      outcome: "persisted_readback_failed",
      message: `energy/save_prefs returned without error, then the readback failed (${errorText(err)}). Nothing else was written.`,
      persistence: "saved",
      readback: "failed",
      ha_version: version.version.raw,
      fingerprint: confirmFingerprint,
      schema: confirmed.schema,
      match_path: confirmed.matchPath,
    });
  }

  const sinceRead = semanticDiff(confirm.prefs, readbackPrefs);
  const fromIntended = semanticDiff(intended, readbackPrefs);
  const matched = fromIntended.length === 0;
  const validation = await readValidation(ws);

  const validateNote =
    validation.status === "failed"
      ? " energy/validate then failed. The save was not undone and this tool will not send another write."
      : " energy/validate returned a body. That body is not graded and was not used to undo or repeat the save.";
  return baseReport({
    success: matched,
    outcome: matched ? "persisted" : "persisted_readback_mismatch",
    message: matched
      ? `The readback matches the intended one-field change. The replacement is persisted. See persistence, readback, diff_since_read, and post_save_validation.${validateNote}`
      : "energy/save_prefs returned without error, but the readback is not the intended document. The save was not undone and this tool will not send another write. Compare persistence, readback, and diff_from_intended.",
    persistence: "saved",
    readback: matched ? "matched" : "mismatch",
    post_save_validation: validation.status,
    ha_version: version.version.raw,
    fingerprint: fingerprintPrefs(readbackPrefs),
    schema: confirmed.schema,
    match_path: confirmed.matchPath,
    diff_since_read: sinceRead,
    diff_from_intended: fromIntended,
    validation: validation.body,
    preferences: readbackPrefs,
  });
}

function applyPlan(
  prefs: unknown,
  oldStatistic: string,
  newStatistic: string,
  version: HaVersion,
):
  | { ok: true; energySources: unknown[]; schema: string; matchPath: string }
  | { ok: false; report: Partial<Report> } {
  const plan = planGridExportReplacement(prefs, oldStatistic, newStatistic, version);
  if (!plan.ok) {
    return {
      ok: false,
      report: {
        outcome: plan.outcome,
        message: plan.message,
        schema: null,
      },
    };
  }
  return {
    ok: true,
    energySources: plan.energySources,
    schema: plan.schema,
    matchPath: plan.matchPath,
  };
}

function intendedPrefs(prefs: unknown, energySources: unknown[]): unknown {
  const next = structuredClone(prefs);
  if (typeof next === "object" && next !== null && !Array.isArray(next)) {
    (next as Record<string, unknown>).energy_sources = energySources;
  }
  return next;
}

async function readVersion(
  rest: RestClient,
): Promise<{ ok: true; version: HaVersion } | { ok: false; report: Partial<Report> }> {
  let config: unknown;
  try {
    config = await rest.get("/api/config");
  } catch (err) {
    const kind = classifyError(err);
    return {
      ok: false,
      report: {
        outcome: kind === "auth" ? "auth_failed" : "version_unavailable",
        message:
          kind === "auth"
            ? "GET /api/config was rejected. Check the long-lived token for this process."
            : `Home Assistant version could not be read (${errorText(err)}). The replacement refuses to continue without it.`,
      },
    };
  }
  const raw =
    typeof config === "object" && config !== null && "version" in config
      ? (config as { version: unknown }).version
      : undefined;
  const version = parseHaVersion(raw);
  if (!version) {
    return {
      ok: false,
      report: {
        outcome: "unsupported_version",
        message: "GET /api/config did not include a YYYY.M version. Nothing was written.",
        ha_version: typeof raw === "string" ? raw : null,
      },
    };
  }
  return { ok: true, version };
}

async function readPrefs(
  ws: WsClient,
): Promise<{ ok: true; prefs: unknown } | { ok: false; report: Partial<Report> }> {
  try {
    const prefs = await ws.sendCommand("energy/get_prefs");
    return { ok: true, prefs };
  } catch (err) {
    const kind = classifyError(err);
    if (kind === "not_found") {
      return {
        ok: false,
        report: {
          outcome: "no_prefs",
          message:
            "energy/get_prefs returned not_found (no Energy preferences stored). Nothing was written.",
        },
      };
    }
    if (kind === "auth") {
      return {
        ok: false,
        report: {
          outcome: "auth_failed",
          message: "energy/get_prefs was rejected for this token. Nothing was written.",
        },
      };
    }
    return {
      ok: false,
      report: {
        outcome: "read_failed",
        message: `energy/get_prefs failed: ${errorText(err)}`,
      },
    };
  }
}

async function readValidation(ws: WsClient): Promise<{ status: Validation; body: unknown }> {
  try {
    const body = await ws.sendCommand("energy/validate");
    return { status: "returned", body };
  } catch (err) {
    return { status: "failed", body: errorText(err) };
  }
}

function classifyError(err: unknown): "auth" | "not_found" | "other" {
  const message = errorText(err);
  if (/HA WS error \(not_found\)/i.test(message)) return "not_found";
  if (
    /HA WS error \((unauthorized|not_allowed)\)/i.test(message) ||
    /authentication failed/i.test(message) ||
    /HA REST \w+ \S+ failed \(401\)/.test(message)
  ) {
    return "auth";
  }
  return "other";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function baseReport(partial: Partial<Report>): Report {
  return {
    support: ENERGY_SUPPORT,
    success: partial.success ?? false,
    outcome: partial.outcome ?? "error",
    message: partial.message ?? "",
    persistence: partial.persistence ?? "not_attempted",
    readback: partial.readback ?? "not_attempted",
    post_save_validation: partial.post_save_validation ?? "not_attempted",
    ha_version: partial.ha_version ?? null,
    fingerprint: partial.fingerprint ?? null,
    schema: partial.schema ?? null,
    match_path: partial.match_path ?? null,
    diff_since_read: partial.diff_since_read ?? [],
    diff_from_intended: partial.diff_from_intended ?? [],
    validation: partial.validation ?? null,
    ...(partial.preferences !== undefined ? { preferences: partial.preferences } : {}),
  };
}

function json(report: Report): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
}
