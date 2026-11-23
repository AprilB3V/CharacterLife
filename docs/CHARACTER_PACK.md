# Character packs

**English** · [简体中文](CHARACTER_PACK.zh-CN.md)

A character pack is a folder that defines one CharacterLife character as plain data: who she is,
how she talks when she starts a conversation, what happens in her own life, and optionally her art.
Packs contain **no code**, so you can share them and load one from a stranger without running
anything they wrote.

```
my-character/
├── character.json        required: manifest, persona, voice, timeline
├── README.md             recommended: what the character is, content notes
├── LICENSE               recommended when the license needs its full text
├── art/                  optional: portrait and expression images
└── notes/                optional: knowledge files for apps
```

The reference pack is [`characters/shen-zhiwei`](../characters/shen-zhiwei/character.json), the test
character. It builds exactly the same template as the built-in default, which the test suite checks.

## Use a pack

```bash
npm run pack:check -- path/to/my-character      # validate and list every problem

export CHARACTERLIFE_CHARACTER_PACK=path/to/my-character
npm run st:server                                # or telegram:server, onebot:server
```

SillyTavern then lists the model `characterlife/<id>`. With Docker, mount the pack and point
`CHARACTERLIFE_CHARACTER_PACK` at the mount path.

**Use one database per character.** An instance remembers which template it was created with; a
database created with another character refuses to load (see [Versions](#versions-and-changes)).

## character.json

Add `"$schema": "<relative path>/docs/schemas/character-pack.v1.schema.json"` to get completion and
inline checks in VS Code and other editors.

### Manifest

| Field | Required | Meaning |
|---|---|---|
| `packFormat` | yes | Always `1` for this version of the format |
| `id` | yes | Stable id: lowercase letters, digits, single hyphens (`shen-zhiwei`). Becomes the model id `characterlife/<id>` and, by default, the template id `char_<id>` |
| `version` | yes | Integer ≥ 1. Bump it whenever `profile`, `voice` or `timeline` changes |
| `name` | yes | Display name for listings (may differ from `profile.name`, e.g. a romanized form) |
| `language` | yes | BCP 47 tag of the language the character speaks: `en`, `zh-CN`, `ja` |
| `summary` | yes | One or two sentences, up to 280 characters |
| `license` | yes | SPDX expression for the text: `CC-BY-4.0`, `CC0-1.0`, `Apache-2.0`, or `LicenseRef-Proprietary` |
| `authors` | yes | `[{ "name": "...", "url": "..." }]`, at least one |
| `homepage` | no | Where the pack lives |
| `templateId` | no | Advanced. Overrides the template id; never change it once someone has chatted with the character |

### `profile`: who the character is

This is the immutable core. At runtime it is frozen, and the policy layer refuses any chat or model
output that tries to change it.

| Field | Limit | Notes |
|---|---|---|
| `name` | 80 | The name she uses for herself |
| `age` | number | Use the apparent age for ageless beings |
| `occupation` | 200 | |
| `background` | 2000 | A short paragraph of history |
| `traits` | 1–12 × 200 | Core personality |
| `values` | 1–12 × 200 | What she cares about |
| `interests` | 1–16 × 120 | Concrete ones work best ("restoring old books", not "reading") |
| `dislikes` | 0–16 × 120 | |
| `speechStyle` | 400 | Sentence length, tone, habits |
| `goals` | 0–8 × 200 | Her own goals, not the user's |
| `contentBoundaries` | 1–12 × 200 | Lines she holds no matter what the user asks |
| `relationshipNotes` | 1000 | How trust grows or shrinks; what never unlocks closeness |
| `shortPersona` | 600, optional | Compact persona used in reply generation instead of the full profile |

`id`, `version` and `immutable` are filled in from the manifest; don't add them.

### `voice`: lines she starts conversations with

`voice.proactive` holds fallback lines for messages the character sends on her own. Each of the five
intents needs at least one line (up to 20, 300 characters each):

| Intent | When |
|---|---|
| `idle_check_in` | The user has been away a while |
| `promise_reminder` | A promise is coming due |
| `life_update` | Something happened in her own life |
| `story_followup` | Following up a plot event |
| `boundary_pushback` | Declining after the user pushed a boundary |

With a real model these lines guide tone; with the offline mock model they are used as written.

### `timeline`: her own life

Optional. Events fire at fictional times after the story starts, whether or not the user is around.

```json
{
  "id": "plot_promise",
  "kind": "plot",
  "at": "1d2h",
  "title": "A promise: come and see the repaired book on Sunday",
  "description": "She says the book will be done by Sunday.",
  "payload": {
    "activity": "patching the book",
    "moodLabel": "focused",
    "moodValence": 0.3,
    "memory": { "title": "A promise", "content": "...", "status": "fiction", "salience": 0.95, "tags": ["promise"] }
  }
}
```

- `kind`: `plot`, `life`, `reminder` or `consequence`.
- `at`: `0`, `9h`, `2d`, `1d2h30m` (days, hours, minutes).
- `payload` is optional. Recognized keys: `activity`, `moodLabel`, `moodValence` (−1..1), `energy`
  (0..1), `milestone` (`kind`, `title`, `evidence`) and `memory` (`title`, `content`, `status`,
  `salience`, `tags`). See the reference pack for complete examples.

### `assets` and `knowledge`

Optional files for apps such as desktop companions. The kernel ignores them; `pack:check` verifies
that each file exists inside the pack and is under 8 MB.

```json
"assets": {
  "portrait": "art/portrait.png",
  "expressions": { "neutral": "art/neutral.png", "smile": "art/smile.png" },
  "license": "CC-BY-NC-4.0"
},
"knowledge": ["notes/world.md"]
```

- Paths are relative, use forward slashes and may not leave the pack folder.
- Images: PNG, WebP or JPEG. Knowledge: `.md`, `.txt` or `.json`.
- Expression names are lowercase (`neutral`, `smug`, `panic`); which names an app uses is up to the
  app.
- `assets.license` covers the art when it differs from the text license; art often does.

## Versions and changes

A pack is hashed when it loads. Every instance (every user's relationship with the character)
records the template id, version and hash it was created with, and refuses to restore when they
don't match. That is how CharacterLife keeps a character from being silently rewritten.

The servers check this at startup. If the database was created with another character, or with an
earlier state of this one, they stop with a message saying which, instead of failing every reply:

```
❌ 1 conversation(s) in data/characterlife.db were created with an earlier char_mara and won't
   restore: the character changed but "version" is still 1.
```

What to do when you change `profile`, `voice` or `timeline`:

- **While writing the character**, use a throwaway database (`CHARACTERLIFE_DB=data/draft.db`) and
  delete it after each change.
- **After people have talked to the character**, bump `version` and either start a new database or
  migrate the existing relationships. Migration is a kernel API today (`migrateTemplate` in
  `src/persistence/store.ts`, which needs the `profile:write` capability and records a
  `template_migrated` event); there is no command for it yet.

Changes to `name`, `summary`, `authors`, `license`, `homepage`, `assets` and `knowledge` don't
affect the hash and need no bump.

## Sharing a pack

- **Write original characters**, or characters you have the rights to. Don't publish packs of real
  people without consent or of characters from other works you don't own.
- **Say what's inside.** Note mature themes or intense topics in `README.md`. Boundaries in
  `contentBoundaries` are enforced by the model's behaviour and the policy layer, not by
  CharacterLife alone; see [SECURITY.md](../SECURITY.md) for what counts as a vulnerability.
- **Pick a license** for the text and, separately if needed, the art.
- Run `npm run pack:check` before publishing.

## Limits of format 1

- One character per pack, one language per pack.
- No per-pack model settings; the server's `CHARACTERLIFE_MODEL_*` apply.
- SillyTavern character cards are not imported automatically. Their fields map roughly to
  `background`, `traits` and `speechStyle`, but a card has no boundaries, relationship rules or
  timeline, so a hand-written pack plays much better.
