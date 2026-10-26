/**
 * 完整性层（宪法 · 完整性微内核 v0.1 的实现）。
 *
 * 回答一个问题：一个角色经历过的事，事后能不能被信任。
 *
 *   K1 身份恒定     identityFingerprint；身份修订只能由 profile:write 发起，且留下记录
 *   K2 意图≠事实    只有登记过的权威（持有 AuthorityToken）能签发事实；一个意图最多一个事实
 *   K3 只增不改     Ledger：哈希链、墓碑擦除；任何拒绝都是一条账本记录
 *   K4 可复现       种子流必须在第一条事实之前登记；模型原始输出完整入账
 *   K5 承诺–揭示    只公开 sha256(salt|原文)；揭示不符被拒；逾期可列出
 *   K6 预先登记     规则在结果之前登记；决定必须引用规则哈希；事后登记的规则不能用于已有结果
 *
 * 设计约束（宪法 §0）：零依赖、纯数据与纯函数（除 node:crypto）、不调用模型、不做 I/O；
 * 违反条款时拒绝并留痕，调用方继续运行；世界层只能加严，不能放宽。
 */

import type { Actor } from '../policy/policy.ts'
import { contentHash } from './canonical.ts'
import { makeCommitment, verifyCommitment } from './commitments.ts'
import { checkIdentityContinuity, identityFingerprint } from './identity.ts'
import type { IdentityViolation } from './identity.ts'
import { Ledger } from './ledger.ts'
import type { LedgerRecord, LedgerVerification } from './ledger.ts'
import { StreamRng, streamSeed } from './seeds.ts'

export * from './canonical.ts'
export * from './ledger.ts'
export * from './identity.ts'
export * from './seeds.ts'
export * from './commitments.ts'

export const CONSTITUTION_VERSION = '0.1'

/** K6 里可以被「决定」引用的结果记录类型。 */
const OUTCOME_KINDS: ReadonlySet<string> = new Set(['fact', 'intent', 'model_output'])

/** 权威凭据：只有登记时拿到的这个对象才能签发事实。内容、模型输出、世界自由文本都伪造不出它。 */
export interface AuthorityToken {
  readonly id: string
  readonly scopes: readonly string[]
}

export type IntegrityRejectCode =
  | 'CAPABILITY_MISSING'
  | 'AUTHORITY_UNKNOWN'
  | 'AUTHORITY_CONFLICT'
  | 'SCOPE_NOT_ALLOWED'
  | 'INTENT_DUPLICATE'
  | 'INTENT_UNKNOWN'
  | 'INTENT_ALREADY_SETTLED'
  | 'SEED_AFTER_FACT'
  | 'SEED_CONFLICT'
  | 'COMMITMENT_UNKNOWN'
  | 'COMMITMENT_ALREADY_REVEALED'
  | 'REVEAL_MISMATCH'
  | 'RULE_UNKNOWN'
  | 'RULE_AFTER_OUTCOME'
  | 'OUTCOME_UNKNOWN'
  | 'IDENTITY_DRIFT'

export interface Rejection {
  ok: false
  code: IntegrityRejectCode
  reason: string
  /** 这次拒绝对应的账本记录（K3：任何拒绝都留痕） */
  rejectionSeq: number
}

export type Outcome<T> = ({ ok: true } & T) | Rejection

export interface IntegrityReport {
  chain: LedgerVerification
  identity: IdentityViolation[]
  /** 签发者在签发时并未登记为权威的事实（应为空） */
  unsignedFacts: number[]
  /** 已过期仍未揭示的承诺 */
  overdueCommitments: number[]
  ok: boolean
}

export interface IntegrityOptions {
  clock: { nowSim(): number }
  /** 已有账本（恢复时传入）；不传则新建并写创世记录 */
  ledger?: Ledger
  /** 宪法文本的哈希（由调用方读文件计算，内核不做 I/O） */
  constitutionHash?: string | null
  /** 账本主体：这个账本属于哪个角色（K1） */
  subject?: { id: string; persona: unknown } | null
}

interface CommitmentState {
  commitment: string
  revealBy: number
  unit: string
  by: string
  revealedSeq: number | null
}

export class Integrity {
  readonly ledger: Ledger
  #clock: { nowSim(): number }
  #tokens = new WeakSet<AuthorityToken>()
  #authorities = new Map<string, { scopes: string[]; seq: number }>()
  #fingerprint: string | null = null
  #subjectId: string | null = null
  #intents = new Map<string, number>()
  #settled = new Map<number, number>()
  #facts = 0
  #streams = new Map<string, string>()
  #commitments = new Map<number, CommitmentState>()
  #rules = new Map<string, { name: string; version: number; seq: number }>()
  #ruleVersions = new Map<string, number>()

  constructor(opts: IntegrityOptions) {
    this.#clock = opts.clock
    this.ledger = opts.ledger ?? new Ledger({ clock: opts.clock })
    if (this.ledger.size === 0) {
      this.ledger.append({
        kind: 'genesis',
        actor: 'kernel',
        content: { constitution: { version: CONSTITUTION_VERSION, hash: opts.constitutionHash ?? null } },
      })
    } else {
      this.#rebuild()
    }
    if (opts.subject) this.#attachSubject(opts.subject)
  }

  /* ------------------------------------------------------------------ K1 */

  /** 当前身份指纹（未绑定角色时为 null）。 */
  get fingerprint(): string | null {
    return this.#fingerprint
  }

  #attachSubject(subject: { id: string; persona: unknown }): void {
    const fp = identityFingerprint(subject.persona)
    this.#subjectId = subject.id
    if (this.#fingerprint === null) {
      this.#fingerprint = fp
      this.ledger.append({ kind: 'identity', actor: 'kernel', content: { subject: subject.id, fingerprint: fp }, fingerprint: fp })
      return
    }
    if (this.#fingerprint !== fp) {
      // 账本里记着的身份与现在加载的人设不同，而且没有修订记录：不静默接受
      this.#reject('kernel', 'IDENTITY_DRIFT', '加载的人设与账本记录的身份指纹不同，且没有身份修订记录', {
        subject: subject.id,
        recorded: this.#fingerprint,
        loaded: fp,
      })
    }
  }

  /** 身份修订：只能由持有 profile:write 的 actor 发起；修订记录携带**新**指纹。 */
  reviseIdentity(actor: Actor, persona: unknown, reason: string): Outcome<{ seq: number; fingerprint: string }> {
    if (!actor.capabilities.has('profile:write')) {
      return this.#reject(actor.id, 'CAPABILITY_MISSING', `${actor.id} 缺少 profile:write，不能修订身份`, { reason })
    }
    const to = identityFingerprint(persona)
    const from = this.#fingerprint
    const rec = this.ledger.append({
      kind: 'identity_revision',
      actor: actor.id,
      content: { subject: this.#subjectId, from, to, reason },
      fingerprint: to,
    })
    this.#fingerprint = to
    return { ok: true, seq: rec.seq, fingerprint: to }
  }

  /* ------------------------------------------------------------------ K3 */

  /** 追加一条与角色相关的记录（带当前指纹）。审计镜像与扩展都走这里。 */
  record(kind: string, actor: string, content: unknown): LedgerRecord {
    return this.ledger.append({ kind, actor, content, fingerprint: this.#fingerprint })
  }

  /** 擦除某条记录的内容本体（被遗忘的权利），追加墓碑。 */
  erase(actor: Actor, seq: number, reason: string): Outcome<{ tombstoneSeq: number }> {
    if (!actor.capabilities.has('memory:delete')) {
      return this.#reject(actor.id, 'CAPABILITY_MISSING', `${actor.id} 缺少 memory:delete，不能擦除账本内容`, { seq })
    }
    const t = this.ledger.erase(seq, actor.id, reason)
    if (!t) return this.#reject(actor.id, 'OUTCOME_UNKNOWN', `记录 #${seq} 不存在、已擦除或是墓碑`, { seq })
    return { ok: true, tombstoneSeq: t.seq }
  }

  #reject(actor: string, code: IntegrityRejectCode, reason: string, detail: unknown = null): Rejection {
    const rec = this.ledger.append({
      kind: 'rejection',
      actor,
      content: { code, reason, detail },
      fingerprint: this.#fingerprint,
    })
    return { ok: false, code, reason, rejectionSeq: rec.seq }
  }

  /* ------------------------------------------------------------------ K2 */

  /**
   * 登记权威。只能由持有 policy:write 的 actor（系统配置 / 所有者）调用 ——
   * 对话、模型输出、世界回执都拿不到这个能力，因此无法扩展权威名单。
   * 同一 id 以相同范围重复登记（例如重启后）返回新凭据、不重复记账；范围不同则拒绝。
   */
  registerAuthority(actor: Actor, id: string, scopes: readonly string[]): Outcome<{ token: AuthorityToken }> {
    if (!actor.capabilities.has('policy:write')) {
      return this.#reject(actor.id, 'CAPABILITY_MISSING', `${actor.id} 缺少 policy:write，不能登记权威`, { id, scopes })
    }
    const normalized = [...new Set(scopes)].sort()
    const existing = this.#authorities.get(id)
    if (existing && contentHash(existing.scopes) !== contentHash(normalized)) {
      return this.#reject(actor.id, 'AUTHORITY_CONFLICT', `权威 ${id} 已以不同范围登记；扩大范围请换新 id`, {
        id,
        registered: existing.scopes,
        requested: normalized,
      })
    }
    if (!existing) {
      const rec = this.ledger.append({ kind: 'authority_registered', actor: actor.id, content: { id, scopes: normalized } })
      this.#authorities.set(id, { scopes: normalized, seq: rec.seq })
    }
    const token: AuthorityToken = Object.freeze({ id, scopes: Object.freeze([...normalized]) })
    this.#tokens.add(token)
    return { ok: true, token }
  }

  /** 登记一个意图。意图本身不改变任何事实；ref 是外部可追溯的唯一键（例如世界动作 id）。 */
  intent(by: string, ref: string, content: unknown): Outcome<{ seq: number }> {
    if (this.#intents.has(ref)) {
      return this.#reject(by, 'INTENT_DUPLICATE', `意图 ${ref} 已登记过`, { ref })
    }
    const rec = this.record('intent', by, { ref, content })
    this.#intents.set(ref, rec.seq)
    return { ok: true, seq: rec.seq }
  }

  /**
   * 签发事实。只认登记时发出的凭据对象；意图（若有）只能被结算一次。
   * 意图内容写了"已完成""系统确认"都没有用 —— 事实只能从这里来。
   */
  issueFact(
    token: AuthorityToken,
    input: { scope: string; intentRef?: string | null; content: unknown },
  ): Outcome<{ seq: number }> {
    const claimed = typeof token?.id === 'string' ? token.id : 'unknown'
    if (!this.#tokens.has(token) || !this.#authorities.has(token.id)) {
      return this.#reject(claimed, 'AUTHORITY_UNKNOWN', `${claimed} 不是登记过的权威（凭据无效）`, { scope: input.scope })
    }
    if (!token.scopes.includes(input.scope)) {
      return this.#reject(token.id, 'SCOPE_NOT_ALLOWED', `权威 ${token.id} 无权签发 ${input.scope}`, { scope: input.scope })
    }
    let intentSeq: number | null = null
    if (input.intentRef !== undefined && input.intentRef !== null) {
      const seq = this.#intents.get(input.intentRef)
      if (seq === undefined) {
        return this.#reject(token.id, 'INTENT_UNKNOWN', `意图 ${input.intentRef} 不存在`, { ref: input.intentRef })
      }
      if (this.#settled.has(seq)) {
        return this.#reject(token.id, 'INTENT_ALREADY_SETTLED', `意图 ${input.intentRef} 已被事实 #${this.#settled.get(seq)} 结算`, {
          ref: input.intentRef,
        })
      }
      intentSeq = seq
    }
    const rec = this.record('fact', token.id, {
      authority: token.id,
      scope: input.scope,
      intent: intentSeq,
      content: input.content,
    })
    if (intentSeq !== null) this.#settled.set(intentSeq, rec.seq)
    this.#facts += 1
    return { ok: true, seq: rec.seq }
  }

  /* ------------------------------------------------------------------ K4 */

  /**
   * 登记一条种子流。必须在第一条事实之前（"账本开头"）；同名同种子重复登记返回新的随机源、
   * 不重复记账（重启恢复用）；同名不同种子拒绝。
   */
  registerSeedStream(actor: string, name: string, seed: string): Outcome<{ rng: StreamRng }> {
    const existing = this.#streams.get(name)
    if (existing !== undefined) {
      if (existing !== seed) {
        return this.#reject(actor, 'SEED_CONFLICT', `种子流 ${name} 已以不同种子登记`, { name })
      }
      return { ok: true, rng: new StreamRng(streamSeed(seed, name)) }
    }
    if (this.#facts > 0) {
      return this.#reject(actor, 'SEED_AFTER_FACT', `已有事实产生，不能再登记种子流 ${name}`, { name, seed })
    }
    this.ledger.append({ kind: 'seed_stream', actor, content: { name, seed } })
    this.#streams.set(name, seed)
    return { ok: true, rng: new StreamRng(streamSeed(seed, name)) }
  }

  seedStreams(): Array<{ name: string; seed: string }> {
    return [...this.#streams].map(([name, seed]) => ({ name, seed }))
  }

  /** 模型原始输出完整入账：复现指"依据账本重放"，而不是重新生成。 */
  recordModelOutput(
    by: string,
    output: { provider: string; model: string; requestFingerprint: string; text: string; usage?: unknown },
  ): LedgerRecord {
    return this.record('model_output', by, output)
  }

  /** 按顺序取出某个 actor（或全部）的模型原始输出，供回放使用。 */
  modelOutputs(by?: string): Array<{ seq: number; by: string; requestFingerprint: string; text: string; provider: string; model: string }> {
    return this.ledger
      .records({ kind: 'model_output' })
      .filter((r) => by === undefined || r.actor === by)
      .flatMap((r) => {
        const c = this.ledger.content(r.seq) as
          | { requestFingerprint: string; text: string; provider: string; model: string }
          | undefined
        return c ? [{ seq: r.seq, by: r.actor, ...c }] : []
      })
  }

  /* ------------------------------------------------------------------ K5 */

  /**
   * 封存：账本里只写校验码与期限。返回的 salt 与原文由调用方私下保管（例如 sealed.json），
   * 不进入任何公开记录。`unit` 说明期限的量纲（模拟时间 / 期数），由世界决定。
   */
  seal(by: string, text: string, revealBy: number, unit = 'sim'): { seq: number; commitment: string; salt: string } {
    const { salt, commitment } = makeCommitment(text)
    const rec = this.record('commitment', by, { commitment, revealBy, unit })
    this.#commitments.set(rec.seq, { commitment, revealBy, unit, by, revealedSeq: null })
    return { seq: rec.seq, commitment, salt }
  }

  /** 揭示：公开 salt 与原文。与承诺不符时拒绝并留痕。 */
  reveal(actor: string, commitmentSeq: number, salt: string, text: string): Outcome<{ seq: number }> {
    const c = this.#commitments.get(commitmentSeq)
    if (!c) return this.#reject(actor, 'COMMITMENT_UNKNOWN', `#${commitmentSeq} 不是承诺`, { commitmentSeq })
    if (c.revealedSeq !== null) {
      return this.#reject(actor, 'COMMITMENT_ALREADY_REVEALED', `承诺 #${commitmentSeq} 已于 #${c.revealedSeq} 揭示`, { commitmentSeq })
    }
    if (!verifyCommitment(salt, text, c.commitment)) {
      return this.#reject(actor, 'REVEAL_MISMATCH', `揭示内容与承诺 #${commitmentSeq} 不符`, { commitmentSeq })
    }
    const rec = this.record('reveal', actor, { target: commitmentSeq, salt, text })
    c.revealedSeq = rec.seq
    return { ok: true, seq: rec.seq }
  }

  /** 已过期仍未揭示的承诺（属于违规）。`now` 与承诺期限同一量纲。 */
  overdue(now: number, unit = 'sim'): number[] {
    return [...this.#commitments]
      .filter(([, c]) => c.unit === unit && c.revealedSeq === null && now > c.revealBy)
      .map(([seq]) => seq)
  }

  /* ------------------------------------------------------------------ K6 */

  /** 预先登记一条规则（心声分级比例、挑局评分、剪辑筛选条件……）。换规则 = 登记新版本。 */
  registerRule(actor: string, name: string, rule: unknown): { seq: number; ruleHash: string; version: number } {
    const version = (this.#ruleVersions.get(name) ?? 0) + 1
    const ruleHash = contentHash({ name, version, rule })
    const rec = this.ledger.append({ kind: 'rule_registered', actor, content: { name, version, ruleHash, rule } })
    this.#ruleVersions.set(name, version)
    this.#rules.set(ruleHash, { name, version, seq: rec.seq })
    return { seq: rec.seq, ruleHash, version }
  }

  /**
   * 依据规则作出的决定（显示级别、选哪一局……）。
   * 规则必须已登记，且登记在它所涉及的每一个结果**之前**。
   * 「结果」是账本里已经产生的东西：事实、意图（角色的输出，例如一条心声）或模型原始输出。
   */
  decide(actor: string, input: { ruleHash: string; outcomes: readonly number[]; content: unknown }): Outcome<{ seq: number }> {
    const rule = this.#rules.get(input.ruleHash)
    if (!rule) return this.#reject(actor, 'RULE_UNKNOWN', '决定引用的规则没有登记', { ruleHash: input.ruleHash })
    for (const seq of input.outcomes) {
      const r = this.ledger.get(seq)
      if (!r || !OUTCOME_KINDS.has(r.kind)) {
        return this.#reject(actor, 'OUTCOME_UNKNOWN', `#${seq} 不是结果记录（事实 / 意图 / 模型输出）`, { seq })
      }
      if (rule.seq > seq) {
        return this.#reject(actor, 'RULE_AFTER_OUTCOME', `规则 ${rule.name} v${rule.version} 登记于结果 #${seq} 之后，不能用于它`, {
          ruleSeq: rule.seq,
          outcome: seq,
        })
      }
    }
    const rec = this.record('decision', actor, { ruleHash: input.ruleHash, rule: rule.name, version: rule.version, outcomes: [...input.outcomes], content: input.content })
    return { ok: true, seq: rec.seq }
  }

  /* -------------------------------------------------------------- 总核对 */

  /** 一次性核对全部可断言的条款。 */
  verify(now: { sim?: number; episode?: number } = {}): IntegrityReport {
    const chain = this.ledger.verify()
    const identity = checkIdentityContinuity(this.ledger.records(), (seq) => this.ledger.content(seq))
    const registeredAt = new Map<string, number>()
    const unsignedFacts: number[] = []
    for (const r of this.ledger.records()) {
      if (r.kind === 'authority_registered') {
        const c = this.ledger.content(r.seq) as { id?: string } | undefined
        if (c?.id && !registeredAt.has(c.id)) registeredAt.set(c.id, r.seq)
      }
      if (r.kind === 'fact') {
        const at = registeredAt.get(r.actor)
        if (at === undefined || at > r.seq) unsignedFacts.push(r.seq)
      }
    }
    const overdueCommitments = [
      ...this.overdue(now.sim ?? this.#clock.nowSim(), 'sim'),
      ...(now.episode !== undefined ? this.overdue(now.episode, 'episode') : []),
    ]
    return {
      chain,
      identity,
      unsignedFacts,
      overdueCommitments,
      ok: chain.ok && identity.length === 0 && unsignedFacts.length === 0 && overdueCommitments.length === 0,
    }
  }

  /** 从已有账本重建索引（恢复时）。凭据对象不重建：权威需要在启动时重新登记以取得新凭据。 */
  #rebuild(): void {
    for (const r of this.ledger.records()) {
      const c = this.ledger.content(r.seq) as Record<string, unknown> | undefined
      if (r.fingerprint !== null && (r.kind === 'identity' || r.kind === 'identity_revision')) this.#fingerprint = r.fingerprint
      if (r.kind === 'identity' && c && typeof c.subject === 'string') this.#subjectId = c.subject
      if (!c) continue
      switch (r.kind) {
        case 'authority_registered':
          this.#authorities.set(String(c.id), { scopes: (c.scopes as string[]) ?? [], seq: r.seq })
          break
        case 'intent':
          this.#intents.set(String(c.ref), r.seq)
          break
        case 'fact':
          this.#facts += 1
          if (typeof c.intent === 'number') this.#settled.set(c.intent, r.seq)
          break
        case 'seed_stream':
          this.#streams.set(String(c.name), String(c.seed))
          break
        case 'commitment':
          this.#commitments.set(r.seq, {
            commitment: String(c.commitment),
            revealBy: Number(c.revealBy),
            unit: String(c.unit ?? 'sim'),
            by: r.actor,
            revealedSeq: null,
          })
          break
        case 'reveal': {
          const target = this.#commitments.get(Number(c.target))
          if (target) target.revealedSeq = r.seq
          break
        }
        case 'rule_registered':
          this.#rules.set(String(c.ruleHash), { name: String(c.name), version: Number(c.version), seq: r.seq })
          this.#ruleVersions.set(String(c.name), Math.max(this.#ruleVersions.get(String(c.name)) ?? 0, Number(c.version)))
          break
      }
    }
  }
}
