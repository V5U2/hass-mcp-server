/**
 * Fail-closed planning for one Energy dashboard grid-export statistic.
 *
 * This is third-party practice, not a Home Assistant stability guarantee.
 * Official WebSocket and REST docs do not publish these preference commands.
 *
 * Practice used here:
 * - ha-mcp documents energy/get_prefs, energy/save_prefs (per-key full replace;
 *   omitted keys stay), and energy/validate after the save. Writes need an
 *   administrator token. https://homeassistant-ai.github.io/ha-mcp/tools/
 * - Through ha-mcp 8.6.0 the published grid field set included stat_energy_to
 *   (Glama schema changelog, withdrawn as a static list in 8.7.0 on 2026-10-15
 *   in favor of reading the running Core).
 * - ha-nexus energy_add_grid_return documents stat_energy_to as the grid-export
 *   statistic on a legacy flow_to entry.
 *   https://glama.ai/mcp/servers/Fistacho/ha-nexus-agent/tools/energy_add_grid_return
 * - Core PR 162200 (merged 2026-02-16) describes the storage change from
 *   flow_from / flow_to / power arrays to one object per grid connection.
 *   It does not name a Core release. OrellBuehler homeassistant-mcp 0.2.0
 *   (2026-06-07) documents that unified model as HA 2026.5+.
 *   https://github.com/OrellBuehler/homeassistant-mcp/releases/tag/v0.2.0
 *
 * Battery sources also use stat_energy_to (ha-nexus energy_add_battery_source).
 * Only type "grid" is eligible.
 */
import { createHash } from "node:crypto";

/** Client-published floor for the unified grid object. Not a Core guarantee. */
export const UNIFIED_GRID_MIN = { year: 2026, month: 5 } as const;

const STATISTIC_ID = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

export const ENERGY_SUPPORT = {
  home_assistant_contract: "not_a_stable_public_api",
  practice: [
    "homeassistant-ai/ha-mcp ha_manage_energy_prefs",
    "OrellBuehler/homeassistant-mcp energy tools (unified grid, HA 2026.5+ as published by that client)",
    "Fistacho/ha-nexus-agent energy_add_grid_return (legacy flow_to stat_energy_to)",
  ],
  commands: ["energy/get_prefs", "energy/save_prefs", "energy/validate"],
  concurrency:
    "Replacements in this process run one at a time. The next call reads again after the earlier call finishes, so a fingerprint taken before that write fails and does not save. Home Assistant still has no server-side lock: a writer outside this process can change preferences between the confirming read and save_prefs, or after the readback. This tool does not roll back.",
  validation:
    "success is true only when the readback matches the intended one-field change. energy/validate is reported separately in post_save_validation and validation. A thrown validate call, or a returned body that may contain issues, does not undo the save, does not make success false after a matched readback, and does not cause another write. Public client docs do not define a stable empty-result schema, so a returned body is not graded.",
} as const;

export interface HaVersion {
  year: number;
  month: number;
  patch: number | null;
  raw: string;
}

export type GridSchema = "legacy_flow" | "unified";

export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

export type PlanFailure =
  | "invalid_statistic"
  | "invalid_prefs"
  | "unsupported_schema"
  | "unsupported_version"
  | "not_found"
  | "ambiguous";

export interface PlanSuccess {
  ok: true;
  schema: GridSchema;
  matchPath: string;
  energySources: unknown[];
}

export interface PlanRejection {
  ok: false;
  outcome: PlanFailure;
  message: string;
}

export function parseHaVersion(raw: unknown): HaVersion | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})\.(\d{1,2})(?:\.(\d+))?$/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const patch = match[3] === undefined ? null : Number(match[3]);
  if (month < 1 || month > 12) return null;
  return { year, month, patch, raw: raw.trim() };
}

export function compareHaVersion(version: HaVersion, year: number, month: number): number {
  if (version.year !== year) return version.year - year;
  return version.month - month;
}

export function isStatisticId(value: string): boolean {
  return STATISTIC_ID.test(value);
}

export function isFingerprint(value: string): boolean {
  return FINGERPRINT.test(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function fingerprintPrefs(prefs: unknown): string {
  return createHash("sha256").update(canonicalJson(prefs)).digest("hex");
}

export function semanticDiff(before: unknown, after: unknown, path = "$"): DiffEntry[] {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) {
      return [{ path, before, after }];
    }
    const diffs: DiffEntry[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      diffs.push(...semanticDiff(before[index], after[index], `${path}[${index}]`));
    }
    return diffs;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const diffs: DiffEntry[] = [];
    for (const key of [...keys].sort()) {
      diffs.push(...semanticDiff(before[key], after[key], `${path}.${key}`));
    }
    return diffs;
  }
  return [{ path, before, after }];
}

export function planGridExportReplacement(
  prefs: unknown,
  oldStatistic: string,
  newStatistic: string,
  version: HaVersion,
): PlanSuccess | PlanRejection {
  if (!isStatisticId(oldStatistic) || !isStatisticId(newStatistic)) {
    return {
      ok: false,
      outcome: "invalid_statistic",
      message:
        "Statistic ids must be Home Assistant entity ids (domain.object_id, lowercase). Other id forms are rejected because the public client examples use entity ids.",
    };
  }
  if (oldStatistic === newStatistic) {
    return {
      ok: false,
      outcome: "invalid_statistic",
      message: "old_statistic and new_statistic must differ. Nothing was written.",
    };
  }
  if (!isPlainObject(prefs) || !Array.isArray(prefs.energy_sources)) {
    return {
      ok: false,
      outcome: "invalid_prefs",
      message:
        "energy/get_prefs did not return an object with an energy_sources array. Nothing was written.",
    };
  }

  const classified = classifySources(prefs.energy_sources);
  if (!classified.ok) {
    return { ok: false, outcome: "unsupported_schema", message: classified.message };
  }

  if (classified.schema !== null && !versionAllows(version, classified.schema)) {
    const band =
      classified.schema === "unified"
        ? `unified grid objects are accepted only on Home Assistant ${UNIFIED_GRID_MIN.year}.${UNIFIED_GRID_MIN.month} or newer`
        : `legacy flow_from/flow_to/power grids are accepted only before Home Assistant ${UNIFIED_GRID_MIN.year}.${UNIFIED_GRID_MIN.month}`;
    return {
      ok: false,
      outcome: "unsupported_version",
      message: `Core ${version.raw} does not match the published client schema band (${band}). Nothing was written.`,
    };
  }

  const matches = findExportMatches(prefs.energy_sources, classified.kinds, oldStatistic);
  if (!matches.ok) {
    return { ok: false, outcome: "unsupported_schema", message: matches.message };
  }
  if (matches.matches.length === 0) {
    return {
      ok: false,
      outcome: "not_found",
      message: `No grid export statistic equals ${oldStatistic}. Import, solar, battery, and other sources were not treated as a match. Nothing was written.`,
    };
  }
  if (matches.matches.length > 1) {
    return {
      ok: false,
      outcome: "ambiguous",
      message: `More than one grid export equals ${oldStatistic} (${matches.matches.map((item) => item.path).join(", ")}). Nothing was written.`,
    };
  }

  const match = matches.matches[0];
  const energySources = structuredClone(prefs.energy_sources);
  const source = energySources[match.sourceIndex] as Record<string, unknown>;
  if (match.flowIndex === null) {
    source.stat_energy_to = newStatistic;
  } else {
    const flows = source.flow_to as Record<string, unknown>[];
    flows[match.flowIndex].stat_energy_to = newStatistic;
  }

  return {
    ok: true,
    schema: match.schema,
    matchPath: match.path,
    energySources,
  };
}

function versionAllows(version: HaVersion, schema: GridSchema): boolean {
  const atUnifiedMin =
    compareHaVersion(version, UNIFIED_GRID_MIN.year, UNIFIED_GRID_MIN.month) >= 0;
  return schema === "unified" ? atUnifiedMin : !atUnifiedMin;
}

interface Classified {
  ok: true;
  schema: GridSchema | null;
  kinds: Array<GridSchema | "not_grid">;
}

function classifySources(sources: unknown[]): Classified | { ok: false; message: string } {
  const kinds: Array<GridSchema | "not_grid"> = [];
  for (let index = 0; index < sources.length; index += 1) {
    const kind = classifySource(sources[index]);
    if (kind === "invalid" || kind === "mixed") {
      return {
        ok: false,
        message: `energy_sources[${index}] is a ${kind} grid shape. Recognized shapes are a legacy grid with flow_from/flow_to/power, or a unified grid object with stat_energy_to. Nothing was written.`,
      };
    }
    kinds.push(kind);
  }
  const gridKinds = new Set(kinds.filter((kind) => kind !== "not_grid"));
  if (gridKinds.size > 1) {
    return {
      ok: false,
      message: "Preferences mix legacy flow grids and unified grid objects. Nothing was written.",
    };
  }
  const schema = gridKinds.values().next().value ?? null;
  return { ok: true, schema: schema ?? null, kinds };
}

function classifySource(source: unknown): GridSchema | "not_grid" | "mixed" | "invalid" {
  if (!isPlainObject(source)) return "invalid";
  if (source.type !== "grid") return "not_grid";
  const hasFlow = "flow_from" in source || "flow_to" in source || "power" in source;
  const hasFlat = "stat_energy_from" in source || "stat_energy_to" in source;
  if (hasFlow && hasFlat) return "mixed";
  if (hasFlow) {
    if ("flow_to" in source && !Array.isArray(source.flow_to)) return "invalid";
    if ("flow_from" in source && !Array.isArray(source.flow_from)) return "invalid";
    if ("power" in source && !Array.isArray(source.power)) return "invalid";
    if (Array.isArray(source.flow_to)) {
      for (const flow of source.flow_to) {
        if (!isPlainObject(flow)) return "invalid";
        if (
          "stat_energy_to" in flow &&
          flow.stat_energy_to !== null &&
          typeof flow.stat_energy_to !== "string"
        ) {
          return "invalid";
        }
      }
    }
    return "legacy_flow";
  }
  if (
    "stat_energy_to" in source &&
    source.stat_energy_to !== null &&
    typeof source.stat_energy_to !== "string"
  ) {
    return "invalid";
  }
  if (
    "stat_energy_from" in source &&
    source.stat_energy_from !== null &&
    typeof source.stat_energy_from !== "string"
  ) {
    return "invalid";
  }
  return "unified";
}

interface ExportMatch {
  schema: GridSchema;
  sourceIndex: number;
  flowIndex: number | null;
  path: string;
}

function findExportMatches(
  sources: unknown[],
  kinds: Array<GridSchema | "not_grid">,
  oldStatistic: string,
): { ok: true; matches: ExportMatch[] } | { ok: false; message: string } {
  const matches: ExportMatch[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const kind = kinds[index];
    if (kind === "not_grid") continue;
    const source = sources[index] as Record<string, unknown>;
    if (kind === "unified") {
      if (source.stat_energy_to === oldStatistic) {
        matches.push({
          schema: "unified",
          sourceIndex: index,
          flowIndex: null,
          path: `energy_sources[${index}].stat_energy_to`,
        });
      }
      continue;
    }
    const flows = Array.isArray(source.flow_to) ? source.flow_to : [];
    for (let flowIndex = 0; flowIndex < flows.length; flowIndex += 1) {
      const flow = flows[flowIndex] as Record<string, unknown>;
      if (flow.stat_energy_to === oldStatistic) {
        matches.push({
          schema: "legacy_flow",
          sourceIndex: index,
          flowIndex,
          path: `energy_sources[${index}].flow_to[${flowIndex}].stat_energy_to`,
        });
      }
    }
  }
  return { ok: true, matches };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortValue(value[key]);
  }
  return sorted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
