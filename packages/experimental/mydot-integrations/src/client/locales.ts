/** Settings-card copy; the console remains the authority for accounts and grants. */

/** Keys rendered by this plugin. */
export type LocaleKey = 'title' | 'description' | 'configured' | 'loading' | 'unavailable' | 'openConsole' | 'permission' | 'noSend' | 'separateLogin'

/** English dictionary. */
export const en: Record<LocaleKey, string> = {
  title: 'MyDot calendar and Outlook',
  description: 'Google Calendar and Outlook with explicit account permissions and email sending disabled.',
  configured: 'Host connection configured. Check account connectivity and Session permissions in the broker console.',
  loading: 'Loading Host configuration…',
  unavailable: 'Broker connection is unavailable. Ask the operator to check the MyDot profile.',
  openConsole: 'Open account and permission console',
  permission: 'Connect accounts, select calendars or mailboxes, and grant an expiry-limited permission to the exact Session. Child agents and scheduled Sessions require their own grants.',
  noSend: 'Email sending and meeting notifications are disabled. Replies and forwards create drafts only. Existing mail can receive categories and flags; marking read, moving and deleting are disabled.',
  separateLogin: 'The console requires a separate human administrator credential. This settings card never receives provider tokens or that credential.',
}

/** Simplified Chinese dictionary. */
export const zh: Record<LocaleKey, string> = {
  title: 'MyDot 日历与 Outlook',
  description: '按账户明确授权 Google 日历与 Outlook，并禁止发送邮件。',
  configured: 'Host 连接已配置。账户连接和 Session 权限请在代理控制台中确认。',
  loading: '正在加载 Host 配置…',
  unavailable: '代理连接不可用。请让运维人员检查 MyDot 配置。',
  openConsole: '打开账户与权限控制台',
  permission: '连接账户、选择日历或邮箱，并对当前 Session 单独授予有期限的权限。子代理和定时任务 Session 需要独立授权。',
  noSend: '禁止发送邮件和会议通知。回复和转发只创建草稿。现有邮件只能设置分类和标志；禁止标为已读、移动和删除。',
  separateLogin: '控制台需要独立的人工管理员凭据。此设置卡片不会接收提供方令牌或管理员凭据。',
}
