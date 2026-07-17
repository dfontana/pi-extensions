# scoped-tools

Registers YAML-specified bash commands as first-class agent tools. Because each command is wrapped as a tool and run in a subprocess, the agent never sees the command template, validation commands, or hidden parameter values — only the tool's name, description, parameter schema, and the final stdout/stderr. Predefined structure and validation make calls more reliable than ad-hoc bash.

## Configuration

Tool specs are read from two files, merged with the project file replacing same-named global tools:

1. `~/.pi/agent/scoped-tools.yaml` (global; honors `PI_AGENT_DIR`)
2. `.pi/scoped-tools.yaml` (project)

Both files map tool names to definitions. YAML block scalars (`|`) are useful for readable multi-line commands and pipelines:

```yaml
deploy_service:
  description: Deploy a service to an environment (dry-run).
  parameters:
    service:
      type: string
      description: Service name to deploy
      validationCmd: list-services | grep -qxF "$1"
    env:
      type: string
      description: "Target environment: dev or prod"
      validationCmd: echo "$1" | grep -qxE 'dev|prod'
    extra_flags:
      type: string
      description: Additional flags passed through to the deploy command
  hiddenParameters:
    auth_token:
      valueFromCmd: get-token --env $ENV
  commandTemplate: |
    deploy --dry-run --service $SERVICE --auth $AUTH_TOKEN \
      $EXTRA_FLAGS
  timeout: 300
```

Fields per tool:

| Field | Required | Meaning |
|---|---|---|
| `description` | yes | Surfaced to the LLM as the tool description. |
| `commandTemplate` | yes | The command to run, with `$UPPER_SNAKE` placeholders. |
| `parameters` | no | Agent-visible parameters. `type` is `string` or `number`; `validationCmd` optionally guards the value. All declared parameters are required. |
| `hiddenParameters` | no | Values computed at call time via `valueFromCmd`; never visible to the agent. |
| `timeout` | no | Per-subprocess timeout in seconds (default 120). |

Config is read once, on the first session start. Edit the YAML, then reload Pi to pick up changes.

## Call pipeline

1. **Validation** — each parameter with a `validationCmd` is checked via `bash -c '<validationCmd>' scoped-tools <value>`: the value is `"$1"` inside the script (works with pipelines and regex checks). Non-zero exit rejects the call, returning the script's stderr to the agent.
2. **Hidden parameters** — evaluated in declaration order with `bash -c`; stdout (trailing newline stripped) becomes the value. Each `valueFromCmd` may reference tool parameters and earlier hidden parameters. A failure aborts the call.
3. **Command** — all values are substituted into `commandTemplate` and the result runs via `bash -c` in the session's working directory, inheriting Pi's environment.
4. **Result** — exit 0 returns stdout (stderr, when non-empty, is appended under a `[stderr]` marker); non-zero exit fails the call with stderr.

## Template substitution

A parameter named `my_param` is referenced as `$MY_PARAM`. Parameter and hidden-parameter names share one uppercase namespace and must be unique after uppercasing. Unknown `$NAMES` are left untouched, so templates can still use environment variables like `$HOME`.

Substitution is **raw text replacement, not shell-quoted**: a value can expand to multiple arguments or flags (useful for pass-through parameters), which also means it can inject arbitrary shell. Use `validationCmd` to constrain any parameter whose value must not be trusted.

## Limitations

- The tool set is fixed per Pi process; adding or editing tools requires a reload.
- Invalid definitions are skipped with a warning notification at session start; a broken project override drops the tool rather than falling back to the global definition.
- All declared parameters are required — model an optional pass-through as a parameter the agent sends as `""`.
