/**
 * 规范化与哈希（完整性层的基础工具，纯函数）。
 *
 * 同一份数据无论键的插入顺序如何，都得到同一串 JSON、同一个哈希：
 * 账本链接、身份指纹、规则哈希都依赖这一点。
 */

import { createHash } from 'node:crypto'

/**
 * 稳定 JSON：对象键按字典序；undefined 字段丢弃。
 * 不是 JSON 能表达的值按确定的方式降级（非有限数字 → 字符串，bigint → 字符串，函数/symbol → null），
 * 保证审计镜像里出现的任意数据都能入账，而不会让业务路径因为哈希而失败。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)))
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return value.toString()
    case 'object': {
      if (value instanceof Date) return value.toISOString()
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value as object).sort()) {
        const v = (value as Record<string, unknown>)[key]
        if (v !== undefined) out[key] = normalize(v)
      }
      return out
    }
    default:
      return null
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 任意数据的内容哈希：sha256(canonicalJson(value))。 */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export const ZERO_HASH = '0'.repeat(64)
