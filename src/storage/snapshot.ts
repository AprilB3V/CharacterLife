/**
 * 原子快照持久化。
 *
 * 目标很小但很具体：
 * - 一份文件、一次写入、要么整体成功要么整体不改（写临时文件再 rename）；
 * - 多个模块（记忆区、工作区）注册各自的 section，各自只读自己的数据；
 * - 带 schemaVersion，读到不兼容版本时显式失败，而不是静默用坏数据。
 *
 * 不引入数据库：V0.1 的数据量在几十 KB 级别，JSON + 原子替换已经足够可靠，
 * 也便于把快照直接用于测试断言与 B 站演示。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SnapshotSection {
  /** section 名称，写入快照的顶层字段 */
  readonly sectionName: string
  toJSON(): unknown
  fromJSON(value: unknown): void
}

export interface SnapshotMeta {
  schemaVersion: number
  savedAtSim: number
  savedAtWall: string
}

export class SnapshotStore {
  #filePath: string
  #schemaVersion: number
  #sections = new Map<string, SnapshotSection>()
  #metaProvider: () => { sim: number; wall: string }

  constructor(
    filePath: string,
    schemaVersion: number,
    metaProvider: () => { sim: number; wall: string } = () => ({ sim: 0, wall: new Date().toISOString() }),
  ) {
    this.#filePath = filePath
    this.#schemaVersion = schemaVersion
    this.#metaProvider = metaProvider
  }

  get filePath(): string {
    return this.#filePath
  }

  register(section: SnapshotSection): this {
    if (this.#sections.has(section.sectionName)) {
      throw new Error(`重复注册 snapshot section: ${section.sectionName}`)
    }
    this.#sections.set(section.sectionName, section)
    return this
  }

  exists(): boolean {
    return existsSync(this.#filePath)
  }

  save(): void {
    const meta = this.#metaProvider()
    const payload: Record<string, unknown> = {
      __meta: {
        schemaVersion: this.#schemaVersion,
        savedAtSim: meta.sim,
        savedAtWall: meta.wall,
      } satisfies SnapshotMeta,
    }
    for (const [name, section] of this.#sections) {
      payload[name] = section.toJSON()
    }

    mkdirSync(dirname(this.#filePath), { recursive: true })
    const tmp = `${this.#filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    try {
      renameSync(tmp, this.#filePath)
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 清理失败不影响主错误 */
      }
      throw err
    }
  }

  /** 返回快照元信息；文件不存在时返回 null。 */
  load(): SnapshotMeta | null {
    if (!existsSync(this.#filePath)) return null
    const raw = readFileSync(this.#filePath, 'utf8')
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      throw new Error(`快照不是合法 JSON: ${this.#filePath}`, { cause: err })
    }
    const meta = parsed.__meta as SnapshotMeta | undefined
    if (!meta || typeof meta.schemaVersion !== 'number') {
      throw new Error(`快照缺少 __meta.schemaVersion: ${this.#filePath}`)
    }
    if (meta.schemaVersion !== this.#schemaVersion) {
      throw new Error(
        `快照 schemaVersion=${meta.schemaVersion} 与引擎期望的 ${this.#schemaVersion} 不兼容；` +
          '请迁移或删除快照后重建（V0.1 不提供自动迁移）',
      )
    }
    for (const [name, section] of this.#sections) {
      if (!(name in parsed)) {
        throw new Error(`快照缺少 section: ${name}`)
      }
      section.fromJSON(parsed[name])
    }
    return meta
  }
}
