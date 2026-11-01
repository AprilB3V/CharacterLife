function readString(raw: string, start: number): { text: string; end: number; complete: boolean } {
    let text = ''
    for (let index = start + 1; index < raw.length; index++) {
        const character = raw[index]!
        if (character === '"') return { text, end: index, complete: true }
        if (character !== '\\') { text += character; continue }
        const escaped = raw[++index]
        if (escaped === undefined) break
        if (escaped === 'u') {
            const digits = raw.slice(index + 1, index + 5)
            if (!/^[0-9a-fA-F]{4}$/.test(digits)) break
            text += String.fromCharCode(parseInt(digits, 16))
            index += 4
        } else {
            const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
            if (!(escaped in escapes)) break
            text += escapes[escaped]
        }
    }
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
    return { text, end: raw.length, complete: false }
}

function replyPrefix(raw: string): string {
    let depth = 0
    for (let index = 0; index < raw.length; index++) {
        const character = raw[index]
        if (character === '{' || character === '[') depth++
        else if (character === '}' || character === ']') depth--
        else if (character === '"') {
            const token = readString(raw, index)
            if (!token.complete) return ''
            let next = token.end + 1
            while (/\s/.test(raw[next] ?? '') && next < raw.length) next++
            if (depth === 1 && token.text === 'reply' && raw[next] === ':') {
                next++
                while (/\s/.test(raw[next] ?? '') && next < raw.length) next++
                return raw[next] === '"' ? readString(raw, next).text : ''
            }
            index = token.end
        }
    }
    return ''
}

export class ReplyStreamDecoder {
    #raw = ''
    #emitted = ''
    #onDelta: (delta: string) => void

    constructor(onDelta: (delta: string) => void) { this.#onDelta = onDelta }

    push(chunk: string): void {
        this.#raw += chunk
        const prefix = replyPrefix(this.#raw)
        if (prefix.length > this.#emitted.length && prefix.startsWith(this.#emitted)) {
            this.#onDelta(prefix.slice(this.#emitted.length))
            this.#emitted = prefix
        }
    }
}
