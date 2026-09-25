import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { modelParamSegments, resolvedModelSegment } from "../model-query/render.ts";
import { compactRow } from "../shared/tool-row.ts";
import { REVIEW_INTELLIGENCE_PREFERENCES, REVIEW_THINKING_LEVELS, canonicalModel, selectReviewModel } from "./selector.ts";

interface ReviewArgs {
  intelligence?: "higher" | "same";
  thinking?: string;
  minimumContextWindow?: number;
}

const renderers = compactRow<ReviewArgs, { model?: string; thinking?: string }>({
  name: "select_review_model",
  title: ({ args, details, status, theme }) => [
    ...modelParamSegments(args, theme),
    status === "success" && resolvedModelSegment(theme, details),
  ],
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "select_review_model",
    label: "Select Review Model",
    description:
      "Deterministically select an available code-review model relative to the active session model. " +
      "Intelligence tiers, inferred from model IDs, are Astra > Opus/Sol > Sonnet/Terra/GLM > Luna > Mini/Haiku/Nano; " +
      "direct providers beat aggregators such as OpenRouter, and distinct peers beat the current model. " +
      "Selection is hard-capped at the Opus/Sol tier: higher tiers are never selected, and an above-cap " +
      "session model is clamped down to the best capped tier.",
    promptSnippet: "Select and validate the model and thinking level for an adversarial code review",
    parameters: Type.Object({
      intelligence: Type.Optional(
        StringEnum(REVIEW_INTELLIGENCE_PREFERENCES, {
          description: '"higher" (default) prefers a higher-tier reviewer; "same" restricts to equal-ranked models.',
        }),
      ),
      thinking: Type.Optional(
        StringEnum(REVIEW_THINKING_LEVELS, {
          description: "Reviewer thinking level. Defaults to high.",
        }),
      ),
      minimumContextWindow: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Minimum context window for eligible models.",
        }),
      ),
    }),
    ...renderers,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Since pi 0.80.8 model loading is async and getAvailable() reads a
      // snapshot; refresh so the selection sees the current registry state.
      const refreshResult = await ctx.modelRegistry.refresh({ signal });
      if (refreshResult.aborted) {
        signal?.throwIfAborted();
        throw new Error("Model refresh was aborted");
      }
      signal?.throwIfAborted();
      const selection = selectReviewModel({
        current: ctx.model,
        available: ctx.modelRegistry.getAvailable(),
        intelligencePreference: params.intelligence,
        minimumContextWindow: params.minimumContextWindow,
        thinking: params.thinking ?? "high",
      });

      const output = {
        model: canonicalModel(selection.selected),
        thinking: selection.thinking,
        reason: selection.reason,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        details: output,
      };
    },
  });
}
