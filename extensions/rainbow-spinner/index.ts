/**
 * Rainbow Spinner Extension
 *
 * Customizes the working indicator with:
 * - A braille spinner cycling through theme colors
 * - A random whimsical phrase shown to the right (changes each agent turn)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_COLORS = [
  "pine",
  "foam",
  "iris",
  "rose",
  "gold",
  "love",
  "pine",
  "foam",
  "iris",
  "rose",
] as const;

const PHRASES = [
  "Pondering...",
  "Reticulating splines...",
  "Brewing coffee...",
  "Consulting the oracle...",
  "Crunching numbers...",
  "Charting a course...",
  "Reading the stars...",
  "Polishing bits...",
  "Warming up neurons...",
  "Untangling thoughts...",
  "Consulting the ether...",
  "Dusting off textbooks...",
  "Channeling wisdom...",
  "Herding tokens...",
  "Spinning up the think-o-tron...",
  "Loading existential dread...",
  "Calculating the unknowable...",
  "Wrangling dependencies...",
  "Asking the magic conch...",
  "Aligning chakras...",
  "Dividing by zero...",
  "Rehydrating context...",
  "Sharpening pencils...",
  "Synthesizing vibes...",
  "Buffering genius...",
  "Debugging reality...",
  "Removing training wheels...",
  "Fast-forwarding entropy...",
  "Engaging warp drive...",
  "Summoning an elder function...",
];

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, ctx) => {
    const phrase = pickRandom(PHRASES);
    const theme = ctx.ui.theme;

    const frames = SPINNER_FRAMES.map((frame, i) => {
      const color = SPINNER_COLORS[i]!;
      return `${theme.fg(color, frame)} ${theme.fg("dim", phrase)}`;
    });

    ctx.ui.setWorkingIndicator({ frames, intervalMs: 80 });
  });
}