/**
 * Social cognition (theory of mind) · pluggable module entry.
 *
 * Imported through `characterlife/social`, not re-exported by the kernel entry, so the kernel
 * surface is unchanged whether or not a host plugs it in. See docs/THEORY_OF_MIND.md.
 */

export * from './types.ts'
export * from './hypotheses.ts'
export * from './sensitivity.ts'
export * from './module.ts'
