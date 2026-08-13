export type SubagentEnvironmentProvider = () => Record<string, string>;

const PROVIDERS = Symbol.for("pi-extensions.subagent.environment-providers.v1");

type Registry = Map<string, SubagentEnvironmentProvider>;

function registry(): Registry {
  const root = globalThis as Record<symbol, unknown>;
  return (root[PROVIDERS] ??= new Map()) as Registry;
}

export function registerSubagentEnvironmentProvider(
  name: string,
  provider: SubagentEnvironmentProvider,
): () => void {
  registry().set(name, provider);
  return () => {
    if (registry().get(name) === provider) registry().delete(name);
  };
}

export function collectSubagentEnvironment(): Record<string, string> {
  return Object.assign({}, ...[...registry().values()].map((provider) => provider()));
}
