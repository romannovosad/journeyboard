/** Where pictures go: JOURNEYBOARD_SHOTS (or JOURNEY_SHOTS_DIR, its first name). Empty means none are taken. */
export function shotsDir() {
  return process.env.JOURNEYBOARD_SHOTS || process.env.JOURNEY_SHOTS_DIR || '';
}
