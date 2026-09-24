/** Preserve enough navigation context for diagnostics without logging URL credentials. */
export function navigationTargetForLog(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    return `${url.origin}${url.pathname}`
  } catch {
    return '[invalid URL]'
  }
}
