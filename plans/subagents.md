## Subagents

Goal: Replace [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) with our own take on it
Wishlist:
- Should still support the live widget, but ideally:
  - Footer states how many active agents running
  - Keybind should toggle a view to see these agents, rather than rendering above the status bar like they do now
  - Should be able to select the agent, press enter, and see it's current transcript.
    - Should be able to jump to prompt agent was given or the latest turn description
    - Should be able to scroll through the chat history
- Inline cards should be one line high, colored, with spinners while they work and checkmarks when they are done.
  - Single line format: `{Agent}[{ModelShortName}{context-size-short}] {Task description} {current task summary}`
  - `ctrl+o` standard keybind should expand to include scrolling preview of last N lines of agent prompt
- Should remove turn limit, not helpful in most cases
- Should better resolve subagent models like "sonnet 1m" or "sonnet 200k" should clearly map to model and context size, using latest versions (unless I said something like "sonnet 4.5")
- Subagents should have access to mcp and tools (just not spawning more subagents).
- Subagents should have some kind of persistence in case they get interrupted from an outage mid-session, so they can resume work
- Subagents should have a structured communication channel back to the main agent when they are done (and the main agent should be able to re-fetch the results when they are done). This should not be redunant (to avoid re-notify) it should be subagent states it's done state (interrupted, complete, out of context) -> parent can fetch this and then decide how to proceed (retry on exponential backoff, fetch results, compact and resume with original prompt and compacted status)
- Ideally can customize the model performing maintence tasks like summarizing what's going on, compaction, etc. Haiku vs ...
- Provide generic agents like General, Explore, Research
