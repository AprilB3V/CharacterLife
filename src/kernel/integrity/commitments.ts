/**
 * K5 承诺–揭示。
 *
 * 需要暂时对某些读者隐藏的内容（例如封存心声），只以承诺的形式进入公开记录：
 *   commitment = sha256(salt | 原文)
 * 揭示时公开 salt 与原文，任何人都能重算核对。
 *
 * salt 只来自密码学随机数（`randomBytes`），不能从公开种子推导 ——
 * 否则知道种子的人就能穷举短文本，提前"揭示"封存内容。
 *
 * 格式与《罐中斗》第一期引擎（src/thoughts.ts）逐位一致，旧的 sealed.json 可以直接核对。
 */

import { createHash, randomBytes } from 'node:crypto'

export function commitmentDigest(salt: string, text: string): string {
  return createHash('sha256').update(`${salt}|${text}`, 'utf8').digest('hex')
}

/** 生成一个承诺。返回的 salt 与原文由调用方私下保管，**不要**写进公开记录。 */
export function makeCommitment(text: string): { salt: string; commitment: string } {
  const salt = randomBytes(16).toString('hex')
  return { salt, commitment: commitmentDigest(salt, text) }
}

export function verifyCommitment(salt: string, text: string, commitment: string): boolean {
  return commitmentDigest(salt, text) === commitment
}
