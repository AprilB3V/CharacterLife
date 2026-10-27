import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createApiServer } from '../../src/api/server.ts'
import type { ApiServerOptions } from '../../src/api/server.ts'
import { CONVERSATION_ACTOR } from '../../src/kernel/policy/policy.ts'
import { cleanupDirs, makeRig } from './helpers.ts'

after(() => cleanupDirs())

const TOKEN_A = 'security-test-credential-alpha'
const TOKEN_B = 'security-test-credential-bravo'

async function boot(multiUser = false) {
    const rig = makeRig()
    const service = rig.runtime.identityService
    const a = service.resolveOrCreate('sillytavern', 'user-a').instance.id
    const b = service.resolveOrCreate('sillytavern', 'user-b').instance.id
    const rt = rig.runtime.runtimeManager.get(b)
    const written = rt.workspace.writeMemory({
        kind: 'episodic', title: 'B private memory', content: 'B private content',
        status: 'fact', origin: 'user_message',
    }, CONVERSATION_ACTOR)
    rig.runtime.runtimeManager.saveSnapshot(rt)
    const credentials = [
        { token: TOKEN_A, platformUserId: 'user-a' },
        { token: TOKEN_B, platformUserId: 'user-b' },
    ]
    const options = {
        runtime: rig.runtime, port: 0, logger: () => {}, stIdentityUserId: 'user-a',
        ...(multiUser ? { credentials } : { token: TOKEN_A }),
    }
    const handle = createApiServer(options)
    const { url } = await handle.listen()
    async function request(path: string, opts: {
        token?: string | null; identity?: string; method?: string; body?: unknown
    } = {}) {
        const token = opts.token === undefined ? TOKEN_A : opts.token
        return fetch(`${url}${path}`, {
            method: opts.method ?? 'GET',
            headers: {
                connection: 'close', 'content-type': 'application/json',
                ...(token === null ? {} : { authorization: `Bearer ${token}` }),
                ...(opts.identity === undefined ? {} : { 'x-characterlife-identity': opts.identity }),
            },
            ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        })
    }
    return {
        rig, handle, request, a, b, memoryId: written.entryId!, credentials,
        close: async () => { await handle.close(); rig.runtime.close() },
    }
}

describe('CL-SEC-001 · credential-bound API identity', () => {
    it('local credential reads A and cannot select already-bound B through headers', async () => {
        const ctx = await boot()
        try {
            assert.equal((await ctx.request(`/v1/characters/${ctx.a}/state`)).status, 200)
            for (const kind of ['state', 'memories']) {
                assert.equal((await ctx.request(`/v1/characters/${ctx.b}/${kind}`, { identity: 'user-b' })).status, 403)
                assert.equal((await ctx.request(`/v1/characters/${ctx.b}/${kind}`)).status, 403)
            }
            const me = await ctx.request('/v1/identity/me')
            assert.equal(((await me.json()) as { platformUserId: string }).platformUserId, 'user-a')
        } finally { await ctx.close() }
    })

    it('rejects forged identity on every mutation before B can be modified', async () => {
        const ctx = await boot()
        try {
            const code = ctx.rig.runtime.identityService.issueBindCode({
                instanceId: ctx.b, targetPlatform: 'sillytavern', createdBy: 'sillytavern:user-b',
            }).code
            const before = ctx.rig.runtime.persistence.listEvents(ctx.b).length
            for (const [path, method, body] of [
                ['/v1/messages', 'POST', { text: '/unbind' }],
                ['/v1/chat/completions', 'POST', { messages: [{ role: 'user', content: '/unbind' }] }],
                ['/v1/sessions', 'POST', {}],
                ['/v1/identity/bind-code', 'POST', {}],
                ['/v1/identity/redeem', 'POST', { code }],
                ['/v1/identity/binding', 'DELETE', undefined],
                [`/v1/memories/${ctx.memoryId}`, 'DELETE', undefined],
            ] as const) {
                assert.equal((await ctx.request(path, { method, body, identity: 'user-b' })).status, 403, path)
                if (method === 'POST') {
                    assert.equal((await ctx.request(path, { method, body: { ...body, identity: 'user-b' } })).status, 403, path)
                    assert.equal((await ctx.request(path, {
                        method, identity: 'user-a', body: { ...body, identity: 'user-b' },
                    })).status, 403, `matching header must not hide forged body: ${path}`)
                }
            }
            assert.equal(ctx.rig.runtime.identityService.instanceFor('sillytavern', 'user-b'), ctx.b)
            assert.equal(ctx.rig.runtime.persistence.listEvents(ctx.b).length, before)
            assert.equal(ctx.rig.runtime.runtimeManager.get(ctx.b).workspace.memory.get(ctx.memoryId)?.deletedAtSim, null)
            assert.equal((await ctx.request(`/v1/memories/${ctx.memoryId}`, { method: 'DELETE' })).status, 404)
            assert.equal(ctx.rig.runtime.identityService.redeemBindCode({
                code, platform: 'sillytavern', platformUserId: 'authorized-code-recipient',
            }).ok, true, 'forged redemption must not consume B binding code')
        } finally { await ctx.close() }
    })

    it('rejects missing or incorrect credentials even with a valid B header', async () => {
        const ctx = await boot()
        try {
            for (const token of [null, '', 'incorrect-token']) {
                assert.equal((await ctx.request('/v1/identity/me', { token, identity: 'user-b' })).status, 401)
            }
        } finally { await ctx.close() }
    })

    it('identity assertions cannot fall back to local-default or hide behind another field', async () => {
        const ctx = await boot()
        try {
            for (const identity of ['user-b', 'local-default', 'unknown-user', '']) {
                const response = await ctx.request('/v1/identity/me', { identity })
                assert.equal(response.status, 403)
                assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'IDENTITY_MISMATCH')
            }
            for (const identity of [null, 42, {}, ['user-a'], '']) {
                assert.equal((await ctx.request('/v1/sessions', {
                    method: 'POST', identity: 'user-a', body: { identity },
                })).status, 403)
            }
            const response = await ctx.request('/v1/sessions', {
                method: 'POST', identity: 'user-a', body: { identity: 'user-a' },
            })
            assert.equal(response.status, 200)
            assert.equal(((await response.json()) as { instanceId: string }).instanceId, ctx.a)
        } finally { await ctx.close() }
    })

    it('independent credentials select their own bound identities without headers', async () => {
        const ctx = await boot(true)
        try {
            for (const [token, platformUserId, instanceId, otherId, otherIdentity] of [
                [TOKEN_A, 'user-a', ctx.a, ctx.b, 'user-b'],
                [TOKEN_B, 'user-b', ctx.b, ctx.a, 'user-a'],
            ]) {
                const me = await ctx.request('/v1/identity/me', { token })
                assert.equal(me.status, 200)
                assert.equal(((await me.json()) as { platformUserId: string }).platformUserId, platformUserId)
                assert.equal((await ctx.request(`/v1/characters/${instanceId}/memories`, { token })).status, 200)
                assert.equal((await ctx.request(`/v1/characters/${otherId}/memories`, { token })).status, 403)
                assert.equal((await ctx.request('/v1/identity/me', { token, identity: otherIdentity })).status, 403)
                const session = await ctx.request('/v1/sessions', { token, method: 'POST', body: {} })
                assert.equal(session.status, 200)
                assert.equal(((await session.json()) as { instanceId: string }).instanceId, instanceId)
                const message = await ctx.request('/v1/messages', {
                    token, method: 'POST', body: { identity: platformUserId, text: '/status' },
                })
                assert.equal(message.status, 200)
                assert.equal(((await message.json()) as { instanceId: string }).instanceId, instanceId)
            }
            ctx.credentials[0]!.platformUserId = 'user-b'
            assert.equal(((await (await ctx.request('/v1/identity/me')).json()) as { platformUserId: string }).platformUserId, 'user-a')
        } finally { await ctx.close() }
    })

    it('new authenticated identity can redeem a cross-platform code without prior binding', async () => {
        const ctx = await boot(true)
        let second: ReturnType<typeof createApiServer> | undefined
        try {
            const service = ctx.rig.runtime.identityService
            const qq = service.resolveOrCreate('qq', 'verified-qq-user').instance.id
            const issued = service.issueBindCode({ instanceId: qq, targetPlatform: 'sillytavern', createdBy: 'qq:verified-qq-user' })
            second = createApiServer({ runtime: ctx.rig.runtime, port: 0, logger: () => {},
                credentials: [{ token: TOKEN_B, platformUserId: 'new-st-user' }],
            })
            const { url } = await second.listen()
            const response = await fetch(`${url}/v1/identity/redeem`, {
                method: 'POST', headers: { authorization: `Bearer ${TOKEN_B}`, connection: 'close' },
                body: JSON.stringify({ code: issued.code }),
            })
            assert.equal(response.status, 200)
            assert.equal(((await response.json()) as { instanceId: string }).instanceId, qq)
            assert.equal(service.instanceFor('sillytavern', 'new-st-user'), qq)
            assert.equal(service.instanceFor('sillytavern', 'user-a'), ctx.a)
        } finally { await second?.close(); await ctx.close() }
    })

    it('internal errors and gateway failure reasons never expose SQL, paths or secrets', async () => {
        const ctx = await boot()
        try {
            const secret = 'SELECT * FROM secrets; C:\\private\\characterlife.db; sk-private-test-key'
            ctx.rig.runtime.persistence.getInstance = () => { throw new Error(secret) }
            const response = await ctx.request(`/v1/characters/${ctx.a}/state`)
            assert.equal(response.status, 500)
            const payload = (await response.json()) as { error: { code: string } }
            assert.equal(payload.error.code, 'INTERNAL')
            assert.doesNotMatch(JSON.stringify(payload), /SELECT|private|characterlife\.db|sk-/)
            ctx.rig.runtime.gateway.handleMessage = async () => ({
                status: 'rejected', platform: 'sillytavern', platformMessageId: null,
                instanceId: null, sessionId: null, reply: null, delivery: null, reason: secret, usage: null,
            })
            const gatewayResponse = await ctx.request('/v1/messages', { method: 'POST', body: { text: 'hello' } })
            assert.equal(gatewayResponse.status, 502)
            assert.doesNotMatch(await gatewayResponse.text(), /SELECT|private|characterlife\.db|sk-/)
        } finally { await ctx.close() }
    })

    it('ambiguous or invalid server credential configuration fails closed', () => {
        const rig = makeRig()
        try {
            const invalidConfigs = [
                {}, { credentials: [] },
                { token: TOKEN_A, credentials: [{ token: TOKEN_B, platformUserId: 'b' }] },
                { credentials: [{ token: TOKEN_A, platformUserId: 'a' }, { token: TOKEN_A, platformUserId: 'b' }] },
                { credentials: [{ token: 'short', platformUserId: 'a' }] },
                { credentials: [{ token: TOKEN_A, platformUserId: '' }] },
            ]
            for (const config of invalidConfigs) {
                assert.throws(() => createApiServer({ runtime: rig.runtime, ...config } as ApiServerOptions))
            }
        } finally { rig.runtime.close() }
    })
})
