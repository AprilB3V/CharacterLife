# Jingjing (English)

The English version of CharacterLife's example character [Jingjing](../jingjing/): an AI whale drifting
around the internet and chatting with whoever she meets. Sharp-tongued but soft-hearted, teases only with
good reason, and asks when she doesn't know instead of making things up.

```bash
npm run pack:check -- characters/jingjing-en
npm run st:server        # SillyTavern model: characterlife/jingjing-en
```

It is the same character as the Chinese pack, translated, with its own id and database; conversations do
not carry over between the two. To make her the default, set `CHARACTERLIFE_DEFAULT_CHARACTER=jingjing-en`.

Content: everyday conversation; no mature content (see `profile.contentBoundaries`).
License: Apache-2.0, same as the repository.
