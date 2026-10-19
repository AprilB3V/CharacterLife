/**
 * 绑定码安全测试：过期、一次性、尝试次数上限、平台不匹配、改绑拒绝。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IdentityService, hashCode } from '../../src/identity/identity-service.ts'
import { cleanupDirs, makeRig } from '../adapters/helpers.ts'

after(() => cleanupDirs())

function serviceWith(opts: { ttlMs?: number; maxAttempts?: number }) {
  const rig = makeRig()
  let now = Date.parse('2025-06-01T00:00:00.000Z')
  const service = new IdentityService({
    persistence: rig.runtime.persistence,
    platformStore: rig.runtime.platformStore,
    template: rig.runtime.template,
    worldId: 'w',
    ids: { next: (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}` },
    nowIso: () => new Date(now).toISOString(),
    codeTtlMs: opts.ttlMs,
    maxAttempts: opts.maxAttempts,
  })
  return { rig, service, advance: (ms: number) => (now += ms) }
}

describe('身份绑定 · 绑定码', () => {
  it('正常签发与消费', () => {
    const { rig, service } = serviceWith({})
    const resolved = service.resolveOrCreate('qq', 'user_a')
    const issued = service.issueBindCode({ instanceId: resolved.instance.id, targetPlatform: 'sillytavern', createdBy: 'qq:user_a' })
    assert.match(issued.code, /^\d{8}$/)
    const redeemed = service.redeemBindCode({ code: issued.code, platform: 'sillytavern', platformUserId: 'local-1' })
    assert.equal(redeemed.ok, true)
    assert.equal(redeemed.instanceId, resolved.instance.id)
    assert.equal(service.instanceFor('sillytavern', 'local-1'), resolved.instance.id)
    rig.runtime.close()
  })

  it('过期后不可用', () => {
    const { rig, service, advance } = serviceWith({ ttlMs: 1000 })
    const resolved = service.resolveOrCreate('qq', 'user_b')
    const issued = service.issueBindCode({ instanceId: resolved.instance.id, targetPlatform: 'sillytavern', createdBy: 'qq' })
    advance(2000)
    const redeemed = service.redeemBindCode({ code: issued.code, platform: 'sillytavern', platformUserId: 'local-2' })
    assert.equal(redeemed.ok, false)
    assert.equal(redeemed.error, 'EXPIRED')
    rig.runtime.close()
  })

  it('一次性：重复消费失败', () => {
    const { rig, service } = serviceWith({})
    const resolved = service.resolveOrCreate('qq', 'user_c')
    const issued = service.issueBindCode({ instanceId: resolved.instance.id, targetPlatform: 'sillytavern', createdBy: 'qq' })
    assert.equal(service.redeemBindCode({ code: issued.code, platform: 'sillytavern', platformUserId: 'l3' }).ok, true)
    const again = service.redeemBindCode({ code: issued.code, platform: 'sillytavern', platformUserId: 'l4' })
    assert.equal(again.error, 'CONSUMED')
    assert.equal(service.instanceFor('sillytavern', 'l4'), null)
    rig.runtime.close()
  })

  it('平台不匹配会消耗尝试次数，超过上限后失败', () => {
    const { rig, service } = serviceWith({ maxAttempts: 3 })
    const resolved = service.resolveOrCreate('qq', 'user_d')
    const issued = service.issueBindCode({ instanceId: resolved.instance.id, targetPlatform: 'qq', createdBy: 'qq' })
    // 码是给 qq 的，却用 sillytavern 消费
    for (let i = 0; i < 3; i++) {
      const r = service.redeemBindCode({ code: issued.code, platform: 'sillytavern', platformUserId: 'l5' })
      assert.equal(r.error, 'PLATFORM_MISMATCH')
    }
    const final = service.redeemBindCode({ code: issued.code, platform: 'sillytavern', platformUserId: 'l5' })
    assert.equal(final.error, 'TOO_MANY_ATTEMPTS')
    rig.runtime.close()
  })

  it('已绑到别的实例的身份不能被静默改绑', () => {
    const { rig, service } = serviceWith({})
    const a = service.resolveOrCreate('qq', 'user_e')
    const b = service.resolveOrCreate('qq', 'user_f')
    const issued = service.issueBindCode({ instanceId: b.instance.id, targetPlatform: 'sillytavern', createdBy: 'qq' })
    service.resolveOrCreate('sillytavern', 'st_1')
    const redeemed = service.redeemBindCode({ code: issued.code, platform: 'sillytavern', platformUserId: 'st_1' })
    assert.equal(redeemed.ok, false)
    assert.equal(redeemed.error, 'ALREADY_BOUND')
    assert.notEqual(service.instanceFor('sillytavern', 'st_1'), b.instance.id)
    assert.ok(a.instance.id)
    rig.runtime.close()
  })

  it('库里只存哈希，不存明文验证码', () => {
    const { rig, service } = serviceWith({})
    const resolved = service.resolveOrCreate('qq', 'user_g')
    const issued = service.issueBindCode({ instanceId: resolved.instance.id, targetPlatform: 'sillytavern', createdBy: 'qq' })
    const row = rig.runtime.db
      .prepare('SELECT code_hash FROM binding_codes WHERE instance_id = ?')
      .get(resolved.instance.id) as { code_hash: string } | undefined
    assert.ok(row)
    assert.equal(row!.code_hash, hashCode(issued.code))
    assert.notEqual(row!.code_hash, issued.code)
    rig.runtime.close()
  })
})
