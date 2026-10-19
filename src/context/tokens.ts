/**
 * Token 估算器。
 *
 * 为什么不用 tiktoken：那需要额外依赖与模型词汇表文件，而本项目坚持零运行时依赖。
 * 这里的估算器是**确定性**的，只用来做上下文预算与压缩判定；真实用量以 Provider
 * 返回的 `usage` 为准（两者都会记录，见 context_requests 表）。
 *
 * 估算规则（偏保守，宁可高估）：
 *   - CJK 字符：1 token / 字
 *   - 全角标点：1 token / 个
 *   - 其他（ASCII 字母数字空白）：约 4 字符 / token，向上取整
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const FULLWIDTH_PUNCT = /[\u3000-\u303f\uff00-\uffef]/

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else if (FULLWIDTH_PUNCT.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** 把 token 预算换算成大约多少中文字符（用于截断时留安全边界）。 */
export function tokensToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens))
}

/** 按 token 预算截断文本，尾部加省略标记（截断本身也会消耗 token，故留 2 个余量）。 */
export function truncateToTokens(text: string, maxTokens: number, marker = '…'): string {
  if (maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  const budget = Math.max(1, maxTokens - estimateTokens(marker))
  let out = ''
  let used = 0
  for (const ch of text) {
    const cost = CJK.test(ch) || FULLWIDTH_PUNCT.test(ch) ? 1 : 0.25
    if (used + cost > budget) break
    out += ch
    used += cost
  }
  return out + marker
}
