import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Candidate models extensions may choose from: the session's scoped models
 * (`/scoped-models`, `--models`, or `enabledModels`) when scoping is
 * configured, otherwise every authenticated model.
 *
 * Scoped entries are matched against the current `getAvailable()` snapshot by
 * provider/id. That drops models that lost auth after startup and returns the
 * registry's up-to-date model objects. Call this after `modelRegistry.refresh()`.
 */
export function selectableModels(ctx: Pick<ExtensionContext, "modelRegistry"> & { scopedModels?: ExtensionContext["scopedModels"] }): Model<Api>[] {
  const available = ctx.modelRegistry.getAvailable();
  const scoped = ctx.scopedModels ?? [];
  if (scoped.length === 0) return available;
  const keys = new Set(scoped.map(({ model }) => `${model.provider}/${model.id}`));
  return available.filter((model) => keys.has(`${model.provider}/${model.id}`));
}
