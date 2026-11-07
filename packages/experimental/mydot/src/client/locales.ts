/** Typed MyDot dictionaries. */
export const NS = 'mydot'
/** English MyDot product copy. */
export const en = {
  deliveryFailed: 'Some child files have not reached the parent inbox. Open the parent and retry.', sourceFailed: 'The source conversation or its files could not be read. Retry or open the original conversation.',
  desktopDisabled: 'Desktop coordination is disabled. Configure all desktop tools before using handoff.', desktopStopping: 'Waiting for desktop operations to finish', desktopAgent: 'Job owns the desktop', desktopFree: 'Desktop is available', release: 'Release for the next job', screen: 'Open owner conversation and screen',
  title: 'MyDot', spaces: 'Spaces', jobs: 'Jobs', artifacts: 'Artifacts', memory: 'Memory', desktop: 'PC handoff',
  method: 'Delivery method', loading: 'Connecting…', retry: 'Retry', failed: 'Could not load MyDot. Retry to reconnect.',
  name: 'Name', purpose: 'Purpose', instructions: 'Instructions', materials: 'Reference paths (one per line)', workspace: 'Execution workspace',
  create: 'Create Space', save: 'Save', archive: 'Archive', start: 'Start conversation', attach: 'Use for this conversation',
  empty: 'Create a Space, add reference files and start a conversation.', none: 'No Space selected',
  open: 'Open original conversation', preview: 'Preview current file', missing: 'File is missing', current: 'Current file reference',
  labelA: 'Job A name', labelB: 'Job B name', requestA: 'Job A request', requestB: 'Job B request', startJobs: 'Start two local jobs',
  destination: 'Send to: {name}', parent: 'Parent conversation', steer: 'Apply as steering', queue: 'Add to next turn', send: 'Send',
  accepted: 'Accepted by inbox; check the conversation for consumption.', uncertain: 'Delivery is unconfirmed. Retry uses the same request ID.',
  running: 'Running', inactive: 'Not running', stop: 'Stop this job', stopping: 'Stop accepted; waiting for the active turn to end. Queued input is retained.', stopped: 'Stopped; queued input is retained.',
  edit: 'Edit text', discard: 'Discard draft', reload: 'Reload current file', dirty: 'Unsaved changes', conflict: 'File changed. Your draft is retained; compare with the current content.', continue: 'Ask to continue with saved version',
  personal: 'Personal MEMORY.md', scoped: 'Space MEMORY.md', noMemory: 'Memory file is missing. Create it before editing.',
  handoff: 'Stop inputs and hand over', human: 'Human owns the PC', fresh: 'A new capture is required before resume', resume: 'Resume job',
  unverified: 'Execution status does not verify the result.', close: 'Close', all: 'All Spaces', newSpace: 'New Space', archived: 'Archived',
  saved: 'Saved', error: 'Operation failed: {message}', details: 'Details', schedules: 'Manage schedules in the existing Schedule panel',
} satisfies Record<string, string>
/** Complete locale key domain. */
export type MyDotKey = keyof typeof en
/** Japanese MyDot product copy. */
export const ja = {
  deliveryFailed: '子の成果物参照を親へ提示できていません。親の会話を開いて再試行してください。', sourceFailed: '原典の会話またはファイルを読み込めません。再試行するか原典を開いてください。',
  desktopDisabled: 'PC の制御は無効です。引継ぎ前に対象となる全ツールの設定が必要です。', desktopStopping: '実行中の PC 操作の終了待ち', desktopAgent: '仕事が PC を担当中', desktopFree: 'PC の担当なし', release: '次の仕事へ解放', screen: '担当会話と画面を開く',
  title: 'MyDot', spaces: 'Space', jobs: '仕事', artifacts: '成果物', memory: '記憶', desktop: 'PC の引継ぎ',
  method: '送信方法', loading: '接続中…', retry: '再試行', failed: 'MyDot を読み込めません。再試行で再接続します。',
  name: '名前', purpose: '目的', instructions: '指示', materials: '参照資料のパス（1行ずつ）', workspace: '実行先 Workspace',
  create: 'Space を作成', save: '保存', archive: 'アーカイブ', start: '会話を開始', attach: 'この会話に関連付ける',
  empty: 'Space を作成し、資料を指定して会話を始めてください。', none: 'Space 未選択',
  open: '原典の会話を開く', preview: '現在のファイルを確認', missing: 'ファイルが見つかりません', current: '現在のファイルへの参照',
  labelA: '仕事 A の名前', labelB: '仕事 B の名前', requestA: '仕事 A の依頼', requestB: '仕事 B の依頼', startJobs: '二つの local 作業を開始',
  destination: '指示先：{name}', parent: '親の会話', steer: '途中指示として反映', queue: '次の依頼に追加', send: '送信',
  accepted: '入力待ちへ受け付けました。消費・反映は会話で確認できます。', uncertain: '送信結果は未確認です。同じ ID で再試行できます。',
  running: '実行中', inactive: '現在は実行していません', stop: 'この仕事を停止', stopping: '停止を受け付けました。実行中の処理が終わるのを待っています。待機中の依頼は保持します。', stopped: '停止済み。待機中の依頼は保持しています。',
  edit: 'テキストを編集', discard: '草稿を破棄', reload: '現在のファイルを再読込', dirty: '未保存の変更', conflict: 'ファイルが更新されています。草稿を保持しました。現在の内容と比較できます。', continue: '保存した版で続きを依頼',
  personal: '個人の MEMORY.md', scoped: 'Space の MEMORY.md', noMemory: '記憶ファイルがありません。作成後に編集できます。',
  handoff: '入力を停止して人へ渡す', human: '人が PC を使用中', fresh: '再開には新しい画面の取得が必要です', resume: '仕事を再開',
  unverified: '実行状態は成果の正しさを保証しません。', close: '閉じる', all: 'すべての Space', newSpace: '新しい Space', archived: 'アーカイブ済み',
  saved: '保存しました', error: '操作できませんでした：{message}', details: '詳細', schedules: '定期作業は既存の定期実行画面で管理できます',
} satisfies Record<MyDotKey, string>
/** Chinese MyDot product copy. */
export const zh = {
  deliveryFailed: '子工作文件尚未提交到父对话，请打开父对话后重试', sourceFailed: '无法读取原始对话或文件，请重试或打开原始对话',
  desktopDisabled: '电脑协调未启用，交接前请配置全部电脑操作工具', desktopStopping: '等待正在执行的电脑操作结束', desktopAgent: '工作正在使用电脑', desktopFree: '电脑尚未分配', release: '释放给下一项工作', screen: '打开负责对话和屏幕',
  title: 'MyDot', spaces: 'Space', jobs: '工作', artifacts: '交付文件', memory: '记忆', desktop: '电脑交接',
  method: '发送方式', loading: '正在连接…', retry: '重试', failed: '无法加载 MyDot，请重试以重新连接',
  name: '名称', purpose: '目的', instructions: '指示', materials: '参考文件路径（每行一个）', workspace: '执行工作区',
  create: '创建 Space', save: '保存', archive: '归档', start: '开始对话', attach: '关联当前对话',
  empty: '创建 Space，指定参考文件并开始对话', none: '未选择 Space',
  open: '打开原始对话', preview: '预览当前文件', missing: '文件已丢失', current: '当前文件引用',
  labelA: '工作 A 名称', labelB: '工作 B 名称', requestA: '工作 A 请求', requestB: '工作 B 请求', startJobs: '开始两项本地工作',
  destination: '发送到：{name}', parent: '父对话', steer: '作为中途指示应用', queue: '加入下一轮请求', send: '发送',
  accepted: '收件箱已接收，请在对话中查看消费和应用情况', uncertain: '发送结果尚未确认，重试将使用同一请求 ID',
  running: '运行中', inactive: '当前未运行', stop: '停止此工作', stopping: '已接收停止请求，正在等待当前操作结束，排队输入仍会保留', stopped: '已停止，排队输入仍会保留',
  edit: '编辑文本', discard: '放弃草稿', reload: '重新加载当前文件', dirty: '存在未保存修改', conflict: '文件已更新，草稿已保留，请与当前内容比较', continue: '使用已保存版本继续工作',
  personal: '个人 MEMORY.md', scoped: 'Space MEMORY.md', noMemory: '记忆文件不存在，可以创建后编辑',
  handoff: '停止输入并交给人', human: '人正在使用电脑', fresh: '恢复前需要重新获取屏幕', resume: '恢复工作',
  unverified: '执行状态不代表结果已经验证', close: '关闭', all: '全部 Space', newSpace: '新建 Space', archived: '已归档',
  saved: '已保存', error: '操作失败：{message}', details: '详情', schedules: '在现有定期执行页面管理计划',
} satisfies Record<MyDotKey, string>
