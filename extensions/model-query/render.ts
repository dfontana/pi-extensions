import { minContextSegment, param, primary, summary, type RowTheme, type Segment } from "../shared/tool-row.ts";
import type { ModelIntelligence } from "./query.ts";

export interface ModelParamArgs {
  model?: string;
  thinking?: string;
  intelligence?: ModelIntelligence;
  excludeCurrentVendor?: boolean;
  minimumContextWindow?: number;
}

const TIER_ICON: Record<ModelIntelligence, string> = { higher: "▲", same: "=", lower: "▼" };

/** `luna max ▲tier ¬vendor ⧉≥200k`: requested model selection parameters. */
export function modelParamSegments(args: ModelParamArgs, theme: RowTheme): Segment[] {
  return [
    args.model && primary(theme, args.model),
    args.thinking && param(theme, args.thinking),
    args.intelligence && TIER_ICON[args.intelligence] && param(theme, `${TIER_ICON[args.intelligence]}tier`),
    args.excludeCurrentVendor && param(theme, "¬vendor"),
    minContextSegment(theme, args.minimumContextWindow),
  ];
}

/** `→ provider/model high`: the resolved model once the call succeeds. */
export function resolvedModelSegment(
  theme: RowTheme,
  details: { model?: string; thinking?: string } | undefined,
): Segment {
  return details?.model ? summary(theme, [details.model, details.thinking].filter(Boolean).join(" ")) : undefined;
}
