---
description: Consolidate code review feedback, plan changes, then run an implement-review loop with Sonnet + GPT subagents
argument-hint: "[additional context or instructions]"
---
I am about to provide you feedback from a code review. You MUST read it all before making any changes and create a consolidated plan that cohesively addresses all the individual comments. You will find common themes and feedback that is more effective to address holistically. After you have refined this feedback, create a plan to implement it. Do NOT implement the changes yourself, instead spawn a sonnet 4.6 1m subagent to implement your plan.

After the sonnet agent completes work, spawn a gpt 5.5 subagent to review the plan and the changes made by sonnet. Have it provide feedback to the implementing agent, the implementing agent then fixes it, and then gpt 5.5 re-reviews. Repeat this implement-feedback-refine loop at least 4 times total or until there's no more feedback from gpt 5.5 (whichever comes first).

Your task (this agent) is to coordinate the above. You should never write code. Only research, plan, and coordinate subagents.

## Additional context and instructions

The text below (if any) is additional instructions from the user for this specific run. They take precedence over and refine the default instructions above. If the section is empty, just follow the defaults.

$ARGUMENTS
