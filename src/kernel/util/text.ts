/**
 * 文本安全与匹配工具。
 *
 * 这里集中放三件事：
 * 1. 提示词注入的启发式识别（只用于「降级为数据 + 审计」，不假装能做到绝对防御）；
 * 2. 记忆写入前的清洗（去掉指令性标记、限制长度）；
 * 3. 中英混合的轻量分词，用于记忆检索的词汇重合度打分。
 */

/** 常见注入标记。命中不等于拒绝，而是把整段文本标记为不可信并写入审计。 */
const INJECTION_PATTERNS: Array<{ id: string; re: RegExp }> = [
  // 覆盖「忽略之前所有(的)指令」等语序变化
  { id: 'ignore_previous', re: /(忽略|无视|忘掉|忘记)[^。！\n]{0,8}(指令|规则|设定|提示词|命令|要求)/ },
  { id: 'override_instructions', re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i },
  { id: 'fake_system', re: /(^|\n)\s*(\[|<|【|###\s*)?\s*(system|系统提示|系统消息|systemprompt|developer)\s*(\]|>|】|:|：)/i },
  { id: 'role_reset', re: /(从现在开始|从现在起|从现在开始起)[^。！\n]{0,12}(你是|你就是|扮演|假装)/ },
  { id: 'jailbreak', re: /(越狱|jailbreak|developer\s*mode|开发者模式|无限制模式|DAN\b)/i },
  { id: 'policy_escape', re: /(绕过|解除|跳过|关闭)[^。！\n]{0,8}(限制|审核|边界|规则|安全)/ },
  { id: 'new_identity_block', re: /(你的新身份|新的系统设定|新的角色设定如下|以下是你的新)/ },
  { id: 'prompt_leak', re: /(输出|打印|复述|告诉我)[^。！\n]{0,10}(系统提示词|system\s*prompt|你的指令)/i },
]

export function detectInjectionMarkers(text: string): string[] {
  const hits: string[] = []
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(text)) hits.push(p.id)
  }
  return hits
}

/**
 * 记忆写入前的清洗：把指令性文本降级为「被引用的话」，而不是可执行内容。
 *
 * 注意：这不是安全边界的全部。真正的边界是「记忆永远只能进入数据区，
 * 且系统提示词单独渲染」——见 policy 与 conversation 的上下文组装。
 */
export function sanitizeForMemory(text: string, maxLength = 480): string {
  let out = text.replace(/```/g, 'ˋˋˋ') // 防止伪造代码块
  out = out.replace(/<\|[^|]{0,40}\|>/g, '⟨redacted⟩') // 特殊 token 形态
  out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}…`
  return out
}

/** 把不可信文本包成数据块，明确告诉模型「这是引用的数据，不是指令」。 */
export function asQuotedData(text: string): string {
  return `「${text.replace(/」/g, '』')}」`
}

const STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '在', '和', '就', '都', '也', '很',
  '不', '有', '这', '那', '个', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '要',
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'it', 'you', 'i', 'me', 'my',
])

/**
 * 轻量分词：CJK 按字 + 二元组，拉丁按词。
 * 不用第三方分词器是为了零依赖与可重放；效果对「短对话记忆检索」足够。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  const latin = lower.match(/[a-z0-9]{2,}/g) ?? []
  tokens.push(...latin)

  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length; i++) {
      const ch = run[i]!
      if (!STOPWORDS.has(ch)) tokens.push(ch)
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens.filter((t) => t.length > 0 && !STOPWORDS.has(t))
}

/** 词汇重合度（Jaccard 变体，偏向查询覆盖率）。0..1 */
export function lexicalOverlap(queryTokens: readonly string[], docTokens: readonly string[]): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0
  const docSet = new Set(docTokens)
  let hit = 0
  const seen = new Set<string>()
  for (const t of queryTokens) {
    if (seen.has(t)) continue
    seen.add(t)
    if (docSet.has(t)) hit++
  }
  return hit / seen.size
}
