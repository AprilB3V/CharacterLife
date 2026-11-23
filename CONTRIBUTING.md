# Contributing to CharacterLife

Thanks for your interest! CharacterLife is a research-stage project: the kernel works and is well
tested, but many questions are still open (see "Where it stands" in the [README](README.md)).
Issues and pull requests are welcome in **English or Chinese** (中文也可以).

## What helps most right now

- **Model reports.** Run the M0 baseline on a model we have not measured and share the numbers
  ([docs/MODELS.md](docs/MODELS.md) explains how). Use the "Model report" issue form.
- **Bug reports with steps to reproduce.** The mock model is deterministic, so a failing command
  or test is the best possible report.
- **English docs.** Most design docs under `docs/` are still Chinese only. Translations of
  `KERNEL.md`, `CONSTITUTION.md` and `AUTONOMY.md` are especially welcome.
- **Platform adapters.** [docs/ADAPTER_PROTOCOL.md](docs/ADAPTER_PROTOCOL.md) describes the contract
  and the steps for a new platform.

For anything larger than a bug fix, please **open an issue first** so we can agree on the approach
before you spend time on it.

## Development setup

You need Node.js 22.6 or newer. There is no build step.

```bash
git clone https://github.com/AprilB3V/CharacterLife.git
cd CharacterLife
npm install          # dev dependencies only (TypeScript for type checking)
npm test             # offline, deterministic; no key and no network needed
npm run typecheck
```

`npm test` runs in a single process (`--test-isolation=none`) because some Windows sandboxes refuse
to spawn one process per test file.

## Ground rules

These keep the project's main promises intact. A pull request that breaks one will be asked to
change, however good the rest is.

1. **No runtime dependencies.** Use Node built-ins. Dev dependencies need a good reason.
2. **Tests stay offline.** Use `MockProvider` or a fake `fetch`; no test may need a key or the
   network. Real-model runs belong in `experiments/` and their results in a report.
3. **Don't route around the kernel.** State changes go through proposals and policy; facts come
   only from a registered authority; ledger records are append-only. If a feature seems to need an
   exception, raise it in an issue. [docs/KERNEL.md](docs/KERNEL.md) and
   [docs/CONSTITUTION.md](docs/CONSTITUTION.md) describe the invariants.
4. **Changing a character template means a new version.** Bump `version` and migrate existing
   instances with `migrateTemplate`; otherwise the stored template hash no longer matches and
   recovery refuses the instance.
5. **Claim only what you measured.** Say what was tested with the mock model, with a real model or
   on a real platform, and what was not. We would rather read "not verified" than a hopeful claim.
6. **No secrets, no private data.** Keys come from the environment; `.env*` files are git-ignored.
   Don't commit real chat logs or platform user IDs.

## Pull requests

- Keep each PR to one topic, with tests for behaviour changes.
- Follow the style of the file you are editing. New code comments and docs are in English.
- Commit messages follow the `type(scope): summary` pattern used in the history, e.g.
  `fix(gateway): keep private pending messages out of group scenes`.
- Open PRs against `main`; maintainers may retarget them to the current development branch.
- Fill in the PR template, including how you tested.

## Licensing

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), as stated in section 5 of that license. There is no CLA.

The mascot artwork in `docs/assets` is licensed separately (see
[docs/assets/LICENSE.md](docs/assets/LICENSE.md)), so we can't accept changes to those illustrations.
Changes to the HTML, CSS and script sources next to them are fine.

## Conduct and security

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as
described in [SECURITY.md](SECURITY.md), not in a public issue.
