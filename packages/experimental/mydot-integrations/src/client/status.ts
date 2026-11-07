/** Browser-safe projection of the Host configuration; never carries a credential or token-file path. */

/** The settings card's minimal snapshot. */
export interface IntegrationStatus {
  status: 'loading' | 'ready' | 'unavailable'
  consoleUrl?: string
}

/**
 * Construct a safe external console link from a redacted settings section.
 * @param status - Configuration mirror readiness, not provider connectivity.
 * @param value - Untrusted redacted Host section.
 * @returns Only readiness and a validated broker console URL.
 */
export function statusOf(status: IntegrationStatus['status'], value: unknown): IntegrationStatus {
  if (status !== 'ready' || value === null || typeof value !== 'object' || !('brokerUrl' in value) || typeof value.brokerUrl !== 'string') return { status }
  try {
    const url = new URL(value.brokerUrl)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
      || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') return { status }
    return { status, consoleUrl: `${url.origin}/admin` }
  } catch { return { status } }
}
