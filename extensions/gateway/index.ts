/**
 * Register pi's existing provider model catalogs against configured internal
 * gateways. Model definitions remain entirely under pi's control.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";

export default function gateway(pi: ExtensionAPI): void {
  const result = loadConfig();
  if (!result.ok) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`gateway disabled: ${result.error}`, "warning");
    });
    return;
  }

  const config = result.config;
  if (!config) return;

  for (const provider of config.providers) {
    pi.registerProvider(provider.provider, {
      baseUrl: provider.baseUrl,
      // Pi resolves leading-! API keys as shell commands when auth is needed.
      // Keeping that native behavior avoids handling or persisting the secret here.
      apiKey: `!${config.keyCommand}`,
      authHeader: provider.authHeader,
      // Common headers are the base layer; provider-specific values win on key collisions.
      headers: { ...config.headers, ...provider.headers },
    });
  }
}
