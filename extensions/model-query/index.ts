import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactRow } from "../shared/tool-row.ts";
import { MODEL_THINKING_LEVELS, resolveModelQuery, type ModelQueryOptions, type ModelQueryResult } from "./query.ts";
import { modelParamSegments, resolvedModelSegment } from "./render.ts";

const renderers = compactRow<ModelQueryOptions, ModelQueryResult>({
  name: "model_query",
  title: ({ args, details, status, theme }) => [
    ...modelParamSegments(args, theme),
    status === "success" && resolvedModelSegment(theme, details),
  ],
});

const IntelligenceSchema = StringEnum(["higher", "same", "lower"] as const, {
  description:
    'Relative intelligence policy: "higher" prefers a tier above the active model, "same" stays at its tier, and "lower" prefers a tier below it.. Omit or set to "same" when context does not specify.',
});

const ThinkingSchema = StringEnum(MODEL_THINKING_LEVELS, {
  description: "Require this exact thinking level; the resolver never silently downgrades it.",
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "model_query",
    label: "Model Query",
    description:
      "Resolve the full model identity from Pi's registry for providing other tool calls. Use this when the user provides " +
      "a loose description of what model they want (such as 'luna max' or 'sol high' or 'a higher intelligence model') to " +
      "transform it into a concerete provide/model identity pluggable to other tool calls. Only supply parameters relevant " +
      "to the context; omitting optional parameters is required when they aren't actually asked for (like 'intelligence')",
    promptSnippet: "Resolve a usable model by policy without inventing unavailable provider/model references",
    parameters: Type.Object({
      model: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Canonical provider/modelId or a short name ('luna') resolved with Pi's fuzzy model search.",
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
    ...renderers,
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
