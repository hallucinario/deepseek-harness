/** Script-free administrative forms; provider values are escaped before entering HTML. */

import type { Connection, State } from './schema.ts'
import type { ResourcePolicy } from './types.ts'

/**
 * Escape a string for both HTML text and a double-quoted attribute.
 * @param value - Untrusted provider or administrator text.
 * @returns Escaped HTML text.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? '')
}

/**
 * Render one script-free page with conservative form and navigation controls.
 * @param title - Plain-text page title.
 * @param content - Already escaped HTML produced by these renderers.
 * @returns Complete administrative HTML document.
 */
export function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#172033;background:#f5f7fb}section,form{background:white;border:1px solid #d4dbe6;border-radius:12px;padding:20px;margin:16px 0}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:8px}input[type=text],input[type=password]{max-width:90%;width:520px}button{cursor:pointer}small{display:block;color:#52627a}a{color:#174ea6}code{overflow-wrap:anywhere}li{margin:10px 0}.notice{padding:16px;border-left:4px solid #376dc0;background:#eaf1ff}</style></head><body><h1>${escapeHtml(title)}</h1>${content}</body></html>`
}

/**
 * Password-entry form; its POST additionally requires the configured Origin header.
 * @returns Complete administrative sign-in page.
 */
export function loginPage(): string {
  return page('MyDot account administration', '<p>Use your separate administrator credential. Do not enter it in an agent conversation.</p><form method="post" action="/admin/login"><label>Administrator token <input type="password" name="token" autocomplete="current-password" required></label><button>Sign in</button></form>')
}

function hidden(csrf: string): string { return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` }
function connectionField(connection: Connection): string { return `<input type="hidden" name="connectionId" value="${escapeHtml(connection.id)}">` }

/**
 * Render connection and expiring-grant controls without serializing credentials.
 * @param state - Broker state; only explicitly selected metadata is rendered.
 * @param csrf - Administrative browser's anti-forgery token.
 * @returns Escaped account-management HTML.
 */
export function homePage(state: State, csrf: string): string {
  const accounts = state.connections.map(connection => `<section><h2>${escapeHtml(connection.label)}</h2><p>${escapeHtml(connection.provider)} · ${connection.enabled ? 'Enabled' : 'Disabled'}</p><small>Connection: <code>${escapeHtml(connection.id)}</code></small><p><a href="/admin/resources?connectionId=${encodeURIComponent(connection.id)}">Choose resources and permissions</a></p><ul>${connection.resources.map(resource => `<li>${escapeHtml(resource.label)}: ${escapeHtml(resource.capabilities.join(', '))}</li>`).join('')}</ul><form method="post" action="/admin/oauth/start">${hidden(csrf)}${connectionField(connection)}<input type="hidden" name="provider" value="${connection.provider}"><label>Consent level <select name="mode"><option value="read">Read only</option><option value="write">Read, personal appointments and drafts</option></select></label><button>Reconnect this account</button></form><form method="post" action="/admin/toggle">${hidden(csrf)}${connectionField(connection)}<input type="hidden" name="enabled" value="${connection.enabled ? 'false' : 'true'}"><button>${connection.enabled ? 'Disable account access' : 'Enable account access'}</button></form><form method="post" action="/admin/disconnect">${hidden(csrf)}${connectionField(connection)}<button>Disconnect and forget local tokens</button></form></section>`).join('')
  const grants = state.grants.map(grant => `<form method="post" action="/admin/revoke">${hidden(csrf)}<input type="hidden" name="connectionId" value="${escapeHtml(grant.connectionId)}"><input type="hidden" name="sessionId" value="${escapeHtml(grant.sessionId)}"><p>Session <code>${escapeHtml(grant.sessionId)}</code> · account <code>${escapeHtml(grant.connectionId)}</code></p><p>${escapeHtml(grant.capabilities.join(', '))} · expires ${escapeHtml(new Date(grant.expiresAt).toISOString())}</p><button>Revoke Session access</button></form>`).join('')
  return page('MyDot connections', `<p class="notice">Email sending and meeting notifications are prohibited. Only private personal appointments and Outlook drafts can be written. Connecting an account grants no agent access by itself.</p><form method="post" action="/admin/oauth/start">${hidden(csrf)}<h2>Connect another account</h2><label>Provider <select name="provider"><option value="google">Google Calendar</option><option value="microsoft">Microsoft Outlook</option></select></label><label>Consent level <select name="mode"><option value="read">Read only</option><option value="write">Read, personal appointments and drafts</option></select></label><button>Continue to provider consent</button></form>${accounts}<h2>Session access</h2><p>Choose an account’s resources to grant an exact Session access. Child agents and scheduled Sessions need their own grants. Revocation applies to the next operation admitted by the broker.</p>${grants || '<p>No Session permissions granted.</p>'}<form method="post" action="/admin/logout">${hidden(csrf)}<button>Sign out</button></form>`)
}

/**
 * Render resource allowlists and a separate exact-Session grant form.
 * @param connection - Display-safe fields are selected from this account.
 * @param resources - Resources discovered using this account's OAuth token.
 * @param csrf - Browser anti-forgery token.
 * @param maxHours - Maximum Session permission lifetime shown to the administrator.
 * @param truncated - Whether resource discovery was bounded to its first page.
 * @returns Escaped forms, with read-only defaults for newly discovered resources.
 */
export function resourcesPage(
  connection: Connection, resources: ResourcePolicy[], csrf: string, maxHours: number, truncated: boolean,
): string {
  const choices = resources.map((resource) => {
    const policy = connection.resources.find(value => value.id === resource.id)
    return `<label><input type="checkbox" name="resource" value="${escapeHtml(resource.id)}"${policy === undefined ? '' : ' checked'}> ${escapeHtml(resource.label)} <small>${escapeHtml(resource.id)}</small></label>`
  }).join('')
  const capabilityChoices = `<label><input type="checkbox" name="capability" value="calendar.read" checked> Read calendars</label><label><input type="checkbox" name="capability" value="calendar.write"> Create, edit and delete safe personal appointments</label>${connection.provider === 'microsoft' ? '<label><input type="checkbox" name="capability" value="mail.read"> Read mail without changing read status</label><label><input type="checkbox" name="capability" value="mail.draft"> Create and edit drafts, including reply and forward drafts</label><label><input type="checkbox" name="capability" value="mail.organize"> Change categories and flags</label>' : ''}`
  return page(`Permissions: ${connection.label}`, `<p><a href="/admin">All accounts</a></p>${truncated ? '<p class="notice">Only the first resource page is shown. Unlisted calendars remain inaccessible.</p>' : ''}<form method="post" action="/admin/policy">${hidden(csrf)}${connectionField(connection)}<h2>Account resource limits</h2>${choices}${capabilityChoices}<button>Save account limits</button></form><form method="post" action="/admin/grant">${hidden(csrf)}${connectionField(connection)}<h2>Grant one Session access</h2><label>Exact Session ID <input type="text" name="sessionId" required autocomplete="off"></label><label>Valid for hours <input type="number" name="hours" value="1" min="0.01" max="${maxHours}" step="0.01" required></label>${choices}${capabilityChoices}<p>The effective permission is the intersection of provider consent, account limits and this Session grant.</p><button>Grant Session access</button></form><form method="post" action="/admin/calendar/create">${hidden(csrf)}${connectionField(connection)}<h2>Create a dedicated calendar</h2><label>Name <input type="text" name="name" value="MyDot" maxlength="200" required></label><p>No sharing or agent permission is added automatically.</p><button>Create private calendar</button></form>`)
}
