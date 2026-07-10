import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { REVIEW_INTELLIGENCE_PREFERENCES, REVIEW_THINKING_LEVELS, selectReviewModel } from "./selector.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "select_review_model",
    label: "Select Review Model",
    description:
      "Deterministically select an available code-review model relative to the active session model. " +
      "Recognized intelligence tiers are Opus/Sol, Sonnet/Terra, Luna, then Mini/Haiku/Nano. " +
      "Use intelligence=\"higher\" (default) to prefer a higher-ranked reviewer, or \"same\" to restrict " +
      "to equal-ranked models only. Within each tier, cross-provider peers are preferred over same-provider " +
      "peers; the current model is a last resort. Unknown tiers are excluded.",
    promptSnippet: "Select and validate the model and thinking level for an adversarial code review",
    parameters: Type.Object({
      intelligence: Type.Optional(
        StringEnum(REVIEW_INTELLIGENCE_PREFERENCES, {
          description:
            'Intelligence tier preference. "higher" (default) selects a higher-tier reviewer when available and falls back to a peer. "same" restricts selection to equal-ranked models only.',
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
          description: "Optional minimum context window to filter eligible models during auto-selection.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const selection = selectReviewModel({
        current: ctx.model,
        available: ctx.modelRegistry.getAvailable(),
        intelligencePreference: params.intelligence ?? "higher",
        minimumContextWindow: params.minimumContextWindow,
        thinking: params.thinking ?? "high",
      });

      const output = {
        currentModel: selection.current?.canonical,
        currentTier: selection.current?.tier,
        selectedModel: selection.selected.canonical,
        selectedTier: selection.selected.tier,
        selectedContextWindow: selection.selected.model.contextWindow,
        thinking: selection.thinking,
        intelligencePreference: selection.intelligencePreference,
        escalated: selection.escalated,
        reason: selection.reason,
        notice: selection.notice,
        excludedUnknownModels: selection.excludedUnknown,
        excludedForThinking: selection.excludedThinking,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        details: output,
      };
    },
  });
}
