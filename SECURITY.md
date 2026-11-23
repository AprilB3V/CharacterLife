# Security Policy

## Supported versions

CharacterLife is pre-1.0. Security fixes go to the latest code on `main`; there are no maintained
release branches yet.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
the repository's **Security** tab → **Report a vulnerability**
([direct link](https://github.com/AprilB3V/CharacterLife/security/advisories/new)).

Include what you found, how to reproduce it, and what an attacker could do with it. This is a
one-person project, so responses are best effort: expect an acknowledgement within a week. Once a
fix is out, we'll credit you in the advisory unless you prefer otherwise.

## What counts

The kernel makes promises that we treat as security boundaries. Breaking any of these is in scope:

- **Policy bypass.** Chat input, model output or a world event changes state it should not be able
  to write (persona, relationship, drives, facts), or gains a capability.
- **Integrity.** A ledger edit or a persona change that the integrity checks fail to detect, or a
  fact accepted without a registered authority.
- **Access control.** Calling the chat API, world API or owner console without the right token;
  getting the owner console to answer non-loopback requests; one user reading another user's
  instance or memories.
- **Secret leaks.** API keys, tokens or platform credentials written to logs, snapshots, the
  database or error messages.

## What doesn't

- **The character saying something off-persona** after a clever prompt. Injection detection is a
  heuristic and the README says so; it's only a vulnerability if the text leads to a state change
  that policy should have refused.
- Issues in model providers, chat platforms or SillyTavern themselves.
- Deployments that deliberately expose the API publicly (`CHARACTERLIFE_ALLOW_PUBLIC=true`) without
  HTTPS or with a weak token.
