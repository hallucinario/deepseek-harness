/** Locale bundles for the Ollama Cloud web provider's settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type OllamaSearchSettingsLocaleKey =
  | 'title' | 'description'
  | 'useOllama' | 'useOllamaHint'
  | 'apiKey' | 'apiKeyHint' | 'apiKeySet' | 'apiKeyUnset'
  | 'searchBaseUrl' | 'searchBaseUrlHint' | 'fetchBaseUrl' | 'fetchBaseUrlHint'
  | 'maxResults' | 'maxResultsHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<OllamaSearchSettingsLocaleKey, string> = {
  title: 'Ollama Cloud search',
  description: 'Set up the Ollama Cloud web search and fetch providers.',
  useOllama: 'Use Ollama Cloud for web search and fetch',
  useOllamaHint: 'On selects both Ollama Cloud operations; off restores the deployment\'s own selection.',
  apiKey: 'API key',
  apiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  apiKeySet: 'A key is configured.',
  apiKeyUnset: 'No key is configured; this provider cannot search or fetch until one is set.',
  searchBaseUrl: 'Search API URL',
  searchBaseUrlHint: 'Include the API prefix, such as https://ollama.com. The provider appends /api/web_search. Leave blank to restore the default.',
  fetchBaseUrl: 'Fetch API URL',
  fetchBaseUrlHint: 'Include the API prefix, such as https://ollama.com. The provider appends /api/web_fetch. Leave blank to restore the default.',
  maxResults: 'Results per search',
  maxResultsHint: 'Results returned per search when the caller requests no smaller bound.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<OllamaSearchSettingsLocaleKey, string> = {
  title: 'Ollama Cloud 搜索',
  description: '设置 Ollama Cloud 的网页搜索与抓取提供方。',
  useOllama: '网页搜索与抓取都使用 Ollama Cloud',
  useOllamaHint: '开启即选中 Ollama Cloud 的两项能力；关闭则恢复本部署自己的选择。',
  apiKey: 'API Key',
  apiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  apiKeySet: '已配置密钥。',
  apiKeyUnset: '未配置密钥；设置之前该提供方无法搜索或抓取。',
  searchBaseUrl: '搜索 API 地址',
  searchBaseUrlHint: '填写含 API 前缀的地址，例如 https://ollama.com；程序追加 /api/web_search，留空恢复默认。',
  fetchBaseUrl: '抓取 API 地址',
  fetchBaseUrlHint: '填写含 API 前缀的地址，例如 https://ollama.com；程序追加 /api/web_fetch，留空恢复默认。',
  maxResults: '每次搜索结果数',
  maxResultsHint: '调用方未要求更小的上限时，单次搜索返回的结果条数。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: OllamaSearchSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}

/** Japanese copy owned by this plugin. */
export const ja: Record<OllamaSearchSettingsLocaleKey, string> ={
  'title': 'Ollama Cloud 検索',
  'description': 'Ollama Cloud の Web 検索と取得のプロバイダーを設定します。',
  'useOllama': 'Web 検索と取得に Ollama Cloud を使う',
  'useOllamaHint': 'オンにすると Ollama Cloud の 2 つの能力をまとめて選び、オフにするとこのデプロイ自身の選択に戻します。',
  'apiKey': 'API キー',
  'apiKeyHint': '設定ファイルには書き込みません。空欄の場合は現在のキーを保持します。',
  'apiKeySet': 'キーを設定済みです。',
  'apiKeyUnset': 'キーが未設定です。設定するまでこのプロバイダーは検索も取得もできません。',
  'searchBaseUrl': '検索 API の URL',
  'searchBaseUrlHint': 'API プレフィックスを含めてください（例: https://ollama.com）。プロバイダーが /api/web_search を付加します。空欄にすると既定値に戻ります。',
  'fetchBaseUrl': '取得 API の URL',
  'fetchBaseUrlHint': 'API プレフィックスを含めてください（例: https://ollama.com）。プロバイダーが /api/web_fetch を付加します。空欄にすると既定値に戻ります。',
  'maxResults': '1 回あたりの検索結果数',
  'maxResultsHint': '呼び出し側がより小さい上限を要求しない場合に、1 回の検索で返す結果数です。',
  'overridden': 'オーバーライド済み',
  'reset': 'デフォルトに戻す',
  'readOnly': 'このデプロイの設定は読み取り専用です。',
  'unavailable': 'このプラグインは現在読み込まれていないため、設定できません。',
  'save': '保存',
  'saving': '保存中…',
  'saveFailed': 'このデプロイは値を受理しませんでした。修正できるよう残しています。',
  'invalidNumber': '数値を入力するか、デフォルトを使う場合は空欄にしてください。',
}
