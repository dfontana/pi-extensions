## pane-control: Does kitty support make sense?
Context: When actively ssh'd in kitty+zmx is the primary way to manage splits, great for TUI testing. But when backgrounding the agent that falls apart as kitty isn't active so the tool calls will start to fail. And if you don't establish a zmx connection then the panes die anyways. Should kitty really be used for this workflow, or should we have the tools only support zellij? I think the answer is yes -- only zellij, and they should only be enabled if the host has zellij installed. We should then maske sure the tool always uses a session specific identity and closes it's own sessions after it's done testing (tear down).
Ask: Remove kitty support from the tools and make it zellij specific, ensuring good hygene.
Follow up: fix the artifacts repo's testing skills, for when it's not working inside zellij

## Intelligence selection
Context: The review tools implement an intelligence selection tool, this could be a good tool/library to use if you make your own subagents / pi-fork like system. See plans/subagents.md for more on that. The idea being the plugin could be used to select agents or models-for-agents (TBD) fit for a task dynamically.
Ask: TBD, WIP.

## mcp: seed the tool prompt with configured MCP names
Context: The mcp search tool gets invoked too much when the agent doesn't know it has things like `gh` to open a PR (or what not), or it doesn't get invoked enough (so it skips reached for it and might start curl'ing / web_fetching jira tickets). We should seed the prompt for the tool with the name of the configured MCPs so it knows what _types_ of tools it might go reaching for, reducing false rates. This needs to be computed based on the configured mcp.json though, so is that something that can dynamically change ? Might require 0.80.7+ of pi for this [dynamic tool feature](https://github.com/earendil-works/pi/blob/v0.80.7/packages/coding-agent/docs/extensions.md#dynamic-tool-loading) (so a bootstrap tool can register ? idk). Maybe mcps only change on /reload and that already would recompute the tool descriptions, but depends if the tool registration has access at that time of lifecycle.
Ask: mcp search prompt is seeded with the mcp names, so agents know what systems or providers exist before reaching into the mcp search


