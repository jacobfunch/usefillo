# Contributing

Thanks for looking under the hood. A quick note on how this repo works.

## This is a mirror

The `@usefillo/*` packages and the Fillo Agent Skill are developed in a private
monorepo and **mirrored here on release**. The code in this repo is the same
code published to npm, but it is a one-way copy: history is force-pushed by an
automated job whenever a release ships.

Because of that, **pull requests against package code can't be merged here** —
there's nowhere for them to land. If you send one, we'll read it, but we'll have
to reproduce the change upstream by hand.

## What helps most

- **Open an issue.** Bug reports, reproductions, missing types, unclear docs,
  and feature requests all go through [the issue tracker](https://github.com/jacobfunch/usefillo/issues).
  A minimal reproduction (package version + a short snippet) turns a report into
  a fix much faster.
- **Ask in the issue if you'd like to send a patch.** For anything beyond a
  one-line fix, open an issue first so we can point you at the right seam and get
  the change through the private repo with a test.

## Security

Please don't file a public issue for anything that looks like a vulnerability —
credential handling, upload sessions, workspace access, redirects, or anything
touching untrusted respondent input. Report it privately instead: use GitHub's
**Report a vulnerability** button on this repo's Security tab, or reach the team
through [fillo.so](https://fillo.so), so we can fix it before it's public.

## Getting help with your own build

If you're building a form and something isn't working, start with
[fillo.so/docs](https://fillo.so/docs) and
[fillo.so/agents](https://fillo.so/agents). Open an issue here if you think the
behavior is a bug in the SDK rather than your integration.
