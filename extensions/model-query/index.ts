import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODEL_THINKING_LEVELS, resolveModelQuery, type ModelQueryOptions } from "./query.ts";

const IntelligenceSchema = StringEnum(["higher", "same"] as const, {
  description: 'Relative intelligence policy: "higher" prefers a tier above the active model, while "same" stays at its tier.',
});

const ThinkingSchema = StringEnum(MODEL_THINKING_LEVELS, {
  description: "Require this exact thinking level; the resolver never silently downgrades it.",
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "model_query",
    label: "Model Query",
    description:
      "Resolve one currently available authenticated model from Pi's registry. Use exact canonical provider/modelId " +
      "references or controlled ID short names only; use the separate intelligence field for higher/same policy. " +
      "Selection applies deterministic thinking, context, vendor, route, intelligence, version, and context-window policy.",
    promptSnippet: "Resolve a usable model by policy without inventing unavailable provider/model references",
    parameters: Type.Object({
      model: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Canonical provider/modelId or a short name resolved with Pi's fuzzy model search.",
        }),
      ),
      intelligence: Type.Optional(IntelligenceSchema),
      excludeCurrentVendor: Type.Optional(
        Type.Boolean({
          description: "Exclude models from the active model's inferred vendor family. Defaults to false.",
        }),
      ),
      thinking: Type.Optional(ThinkingSchema),
      minimumContextWindow: Type.Optional(
        Type.Integer({ minimum: 1, description: "Minimum context-window size for eligible models." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // getAvailable() is a synchronous snapshot. Refresh exactly once per
      // invocation so the pure resolver never performs registry I/O itself.
      const refreshResult = await ctx.modelRegistry.refresh({ signal });
      if (refreshResult.aborted) {
        signal?.throwIfAborted();
        throw new Error("Model refresh was aborted");
      }
      signal?.throwIfAborted();
      const options = params as ModelQueryOptions;
      const result = resolveModelQuery({
        ...options,
        current: ctx.model,
        available: ctx.modelRegistry.getAvailable(),
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
