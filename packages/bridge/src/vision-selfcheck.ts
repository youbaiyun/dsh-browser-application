/**
 * The startup check that the cost switch actually took effect.
 *
 * A provider that ignores `thinking: {type: 'disabled'}` answers normally, so
 * nothing looks wrong while every image costs several times the image itself —
 * thinking tokens are the large part of the bill on a pure perception task. The
 * request body cannot prove it was honoured; `usage` can.
 *
 * This runs once, in the background, and only ever warns. A deployment whose
 * provider reports nothing stays quiet rather than crying wolf: zero means "none
 * billed as far as this response says", not proof.
 *
 * @module
 */

import type { VisionClient } from './vision.ts'

/** Run the probe and report a switch that was silently ignored. */
export function checkThinkingIsOff(vision: VisionClient, warn: (message: string) => void): void {
  void vision.probe().then((probe) => {
    if (!probe.ok) {
      warn(`browser bridge: vision self-check could not run (${probe.message}); the thinking switch is unverified`)
      return
    }
    if (probe.reasoningTokens > 0) {
      warn(
        `browser bridge: visionThinking is "off" but the provider billed ${String(probe.reasoningTokens)} reasoning tokens. `
        + 'The switch is being ignored, so each image costs more than the image itself. '
        + 'Set visionThinking to "low" if that is intended, or use an endpoint that honours the switch.',
      )
    }
  }).catch(() => {
    // A diagnostic must never be able to break startup.
  })
}
