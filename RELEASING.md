# Releasing

The package is published as [`context-fold`](https://www.npmjs.com/package/context-fold) from
[`Middlewatch/context-fold`](https://github.com/Middlewatch/context-fold). What follows is the
checklist for every release after the first. These steps leave the machine, which is why they are
a checklist rather than a script.

## Every publish

```bash
npm install                # a clean node_modules, so the checks below test what ships
npm run typecheck
npm test                   # prepublishOnly runs both again, but fail early
npm pack --dry-run         # read the file list: nothing from tests/ or scripts/ belongs in it
npm publish --access public
```

`prepublishOnly` runs typecheck and the full suite, so a broken tree cannot be published by
accident. `npm whoami` should print your account, and `npm login` fixes it if not.

Before tagging, check that the version in `package.json`, the newest heading in `CHANGELOG.md`, and
any version claim in `README.md` all agree.

## Versioning

Semver. While the major is `0`, treat a change to fold *timing* or to the seed-index record shape as
a minor bump and document it in `CHANGELOG.md`, because downstream recall tooling reads that format.
Documentation-only and display-only changes are patch releases and say so in their changelog entry.

## What ships

The `files` allowlist in `package.json` is deliberately narrow: `index.ts`, `src/`, `docs/`,
`DESIGN.md` and `CHANGELOG.md`, plus the `README.md`, `LICENSE` and `package.json` npm always includes. Tests, the
live e2e scripts, `tsconfig.json` and `vitest.config.ts` stay out. Pi loads the TypeScript source
directly through jiti, so there is no build step and no compiled output to ship.

`tsconfig.json` is excluded on purpose: its `paths` point into this repo's `node_modules`, which
does not exist inside an installed package.

## Dependencies

The package installs **nothing**. Pi bundles `typebox` and `@earendil-works/pi-coding-agent` and
injects them into extensions at runtime, so both are declared as optional peer dependencies.
Optional means npm 7+ does not try to install a copy of the whole Pi CLI alongside the extension,
and peer means nobody vendors a second copy that would miss the engine's model registry.

A real runtime dependency, if one is ever added, goes in `dependencies`: Pi runs
`npm install --omit=dev` when installing a package, so `devDependencies` are not available at
runtime.

## Verifying the published package

```bash
pi -e npm:context-fold           # one session, no install
CONTEXTFOLD_DEBUG=1 pi -e npm:context-fold
```

With `CONTEXTFOLD_DEBUG=1` each turn prints a one-line fold summary, so you can see that the
extension loaded and is folding. `/context-fold` reports status inside a session.

## Live end-to-end checks

`scripts/e2e-*.sh` drive real Pi sessions against a real provider and therefore cost money. They
are not part of `npm test`. Run them against a release candidate when the folding path itself
changed:

```bash
scripts/e2e-ladder.sh          # fold event fires, index emitted, head byte-stable, buried value recalled
scripts/e2e-resume.sh          # folds survive a session restart
scripts/e2e-compact-resume.sh  # folds survive real hard compaction plus a restart
```

Override the provider and model with `E2E_PROVIDER` / `E2E_MODEL`. These scripts were written
against a model with reliable tool use, so a weaker model can fail a check for its own reasons
rather than the extension's, so read a failure before believing it.

One known way (c) can fail spuriously: an earlier run against a local model reported `shared=0`,
which is the script finding no folded block present in both turns to compare, rather than bytes
moving. It happens when the agent chooses `unfold` over `recall_folded` in turn 2, deliberately
rendering the block raw and removing it from turn 2's folded set. If (c) fails that way, compare the
two `CONTEXTFOLD_DUMP` views directly and check whether the agent called `unfold` before concluding
the head is unstable. The underlying byte-stability property is also asserted deterministically in
`tests/frozen-layers.test.ts`.
