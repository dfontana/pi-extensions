# rainbow-spinner

Custom working indicator: a braille spinner that cycles through theme colors, with a random whimsical phrase ("Pondering...", "Reticulating splines...", …) picked fresh each agent turn.

## Configuration

None.

## Provides

- Replaces pi's working indicator (frames + phrase) on every `before_agent_start`; suppresses the default working message.

## Limitations and Technical details

- Colors come from the active theme's palette (accent, success, warning, etc.), so the spinner adapts to theme changes automatically.
