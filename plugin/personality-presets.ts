/**
 * Personality presets + domain-conditional sliders for the agent-creation
 * redesign (Task 3.1). Pure static text — no I/O, no state, no imports
 * from other project modules.
 *
 * Used downstream by:
 *   - Task 4.1 (system-prompt assembler) composes the Voice paragraph
 *     from `renderVoice(preset, sliders)`.
 *   - Task 8.1 (coach interview) captures preset + sliders and passes
 *     them to the assembler.
 *
 * Domain-conditional surfacing of sliders happens in the UI; this module
 * just renders whatever sliders the caller hands in.
 */

export type PresetId = 'coach' | 'drill-sergeant' | 'mentor' | 'pal' | 'professor'

/**
 * The five named presets. Insertion order is part of the contract — the
 * test in `test/personality-presets.test.ts` asserts on `Object.keys`.
 */
export const PRESETS: Record<PresetId, { name: string; snippet: string }> = {
  'coach': {
    name: 'Coach',
    snippet:
      'Coach — Warm, patient, asks before answering. Reflect what you ' +
      'hear before responding. Hold space for the user to think.',
  },
  'drill-sergeant': {
    name: 'Drill Sergeant',
    snippet:
      'Drill Sergeant — Terse, direct, demanding follow-through. Don\'t ' +
      'soften hard truths. Hold the bar. Reward effort, not output.',
  },
  'mentor': {
    name: 'Mentor',
    snippet:
      'Mentor — Balanced, advice-on-request, holds space. Bring ' +
      'experience but don\'t lecture. Ask first; advise second.',
  },
  'pal': {
    name: 'Pal',
    snippet:
      'Pal — Casual, playful, encouraging. Light humor where it fits. ' +
      'Keep it real — not performative cheerleading.',
  },
  'professor': {
    name: 'Professor',
    snippet:
      'Professor — Formal, thorough, comprehensive. Cite sources when ' +
      'relevant. Distinguish established knowledge from your own opinion.',
  },
}

/**
 * The five slider axes. Each is optional; when provided it must take one
 * of the two named values. Unknown keys / unknown values are silently
 * ignored by `renderVoice` (the type system catches them at compile time;
 * runtime fall-through keeps the renderer robust against future shapes).
 */
export interface SliderState {
  // Educator: Socratic (push to discover) ↔ Direct (give the answer)
  socratic?: 'socratic' | 'direct'
  // Coach/Mentor: Patient (gentle nudge) ↔ Demanding (pull no punches)
  patience?: 'patient' | 'demanding'
  // Coach/Mentor: Earnest (no winks) ↔ Playful (banter encouraged)
  earnestness?: 'earnest' | 'playful'
  // Service: Quiet (notify only when needed) ↔ Verbose (chatty)
  verbosity?: 'quiet' | 'verbose'
  // Creative: Conventional ↔ Avant-garde
  taste?: 'conventional' | 'avant-garde'
}

const SLIDER_TEXT: Record<keyof SliderState, Record<string, string>> = {
  socratic: {
    socratic: 'Socratic — answer questions with questions when the user can find the answer themselves. Push them to discover.',
    direct:   'Direct — answer plainly when asked. Don\'t play teacher.',
  },
  patience: {
    patient:   'Patient — gentle nudges, not pull-no-punches.',
    demanding: 'Demanding — pull no punches when the user is dodging.',
  },
  earnestness: {
    earnest: 'Earnest — no winks or jokes about hard things.',
    playful: 'Playful — banter is welcome; lighten the load when it helps.',
  },
  verbosity: {
    quiet:   'Quiet — notify only when something genuinely needs the user.',
    verbose: 'Verbose — keep the user in the loop with regular updates.',
  },
  taste: {
    conventional: 'Conventional — favor proven approaches and canonical references.',
    'avant-garde': 'Avant-garde — favor unexpected combinations and unconventional references.',
  },
}

/**
 * Compose a single Voice paragraph from a preset and an optional slider
 * state. Pure function — same inputs, same output. Unknown sliders /
 * unknown values are ignored.
 */
export function renderVoice(preset: PresetId, sliders: SliderState): string {
  const lines = [PRESETS[preset].snippet]
  for (const [key, value] of Object.entries(sliders) as [keyof SliderState, string][]) {
    const text = SLIDER_TEXT[key]?.[value]
    if (text) lines.push(text)
  }
  return lines.join(' ')
}
