/* Shared polling helper for the full-system scenarios. Each provider loop waits on the same shape of
 * thing — an order reaching a status, a report appearing — on its own cadence, so the interval and
 * budget stay per-caller while the loop itself lives here. */

/* Poll a request until `done` holds or the deadline passes; returns the last response either way, so
 * the caller asserts on a real value (and gets a legible diff) rather than on a timeout. */
export async function pollUntil<T> (
  fetchFn: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await fetchFn()
  while (!done(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    last = await fetchFn()
  }
  return last
}
