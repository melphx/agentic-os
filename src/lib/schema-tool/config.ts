/**
 * Schema Tool — configuration (env vars only, never hardcoded credentials)
 *
 *   SCHEMA_TOOL_WP_URL           WordPress site that runs the phr-schema API (default: staging)
 *   SCHEMA_TOOL_WP_USER          WordPress login name of the API user (e.g. schemabot)
 *   SCHEMA_TOOL_WP_APP_PASSWORD  WordPress Application Password for that user
 *   SCHEMA_TOOL_PROD_ORIGIN      Production origin used in HFCM snippet names (default https://phxhomeremodeling.com)
 *
 *   ANTHROPIC_API_KEY            If set, the assistant uses Claude (SCHEMA_TOOL_ANTHROPIC_MODEL)
 *   OPENAI_API_KEY               Otherwise falls back to OpenAI (SCHEMA_TOOL_OPENAI_MODEL || OPENAI_MODEL)
 */

export const SCHEMA_UA = 'PHR-Schema-Bot/1.0'

export interface SchemaToolConfig {
  siteUrl: string
  siteLabel: string
  user: string
  appPassword: string
  prodOrigin: string
  configured: boolean
}

export function getConfig(): SchemaToolConfig {
  const siteUrl = (process.env.SCHEMA_TOOL_WP_URL || 'https://znee8v7mwj-staging.wpdns.site').replace(/\/+$/, '')
  const user = process.env.SCHEMA_TOOL_WP_USER || ''
  const appPassword = process.env.SCHEMA_TOOL_WP_APP_PASSWORD || ''
  return {
    siteUrl,
    siteLabel: /staging/i.test(siteUrl) ? 'Staging' : siteUrl.replace(/^https?:\/\//, ''),
    user,
    appPassword,
    prodOrigin: (process.env.SCHEMA_TOOL_PROD_ORIGIN || 'https://phxhomeremodeling.com').replace(/\/+$/, ''),
    configured: Boolean(user && appPassword),
  }
}

export type AiProvider = 'anthropic' | 'openai' | 'none'

export function getAiProvider(): { provider: AiProvider; model: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: process.env.SCHEMA_TOOL_ANTHROPIC_MODEL || 'claude-sonnet-4-5' }
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: 'openai', model: process.env.SCHEMA_TOOL_OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini' }
  }
  return { provider: 'none', model: '' }
}

/** Map a production URL (snippet names) to the configured site and back. */
export function toSiteUrl(u: string): string {
  const c = getConfig()
  if (u.startsWith('/')) return c.siteUrl + u
  return u.replace(c.prodOrigin, c.siteUrl)
}

export function toProdUrl(u: string): string {
  const c = getConfig()
  if (u.startsWith('/')) return c.prodOrigin + u
  return u.replace(c.siteUrl, c.prodOrigin)
}

export function urlPath(u: string): string {
  return u.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') || '/'
}
