<p align="center">
  <a href="https://fillo.so">
    <img src="https://fillo.so/brand/readme-banner.png" alt="Fillo — forms inside your product, with your UI." />
  </a>
</p>

<p align="center">
  <a href="https://fillo.so/docs">Docs</a> ·
  <a href="https://fillo.so/guides">Guides</a> ·
  <a href="https://fillo.so/agents">Agents</a> ·
  <a href="https://fillo.so/changelog">Changelog</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@usefillo/cli"><img src="https://img.shields.io/npm/v/@usefillo/cli" alt="npm version" /></a>
  <img src="https://img.shields.io/npm/l/@usefillo/cli" alt="MIT license" />
</p>

`fillo` — create and publish [Fillo](https://fillo.so) forms from your terminal. Auth once, then your coding agent does the rest.

```sh
npx @usefillo/cli init --email you@company.com # start a workspace and email its link
npx @usefillo/cli login                         # connect an existing account in the browser
npx @usefillo/cli project create "Customer site" # create + select an isolated site/app
npx @usefillo/cli push form.json --handle hello --stage # stage for dashboard review
npx @usefillo/cli@latest skill install           # install the project Agent Skill
```

Commands: `init`, `login`, `logout`, `whoami`, `project list|create|select`, `push <file|->`, `list`,
`agent bootstrap`, `agent connect`, `agent event`, and `skill install`. Run
`npx @usefillo/cli --help` for flags. The canonical skill is
one portable Agent Skills bundle. The default command installs it in the shared
`.agents/skills` path and Claude Code's `.claude/skills` path — both get the
same files, for cross-agent compatibility rather than duplication. Hosts with
another location can use `skill install --dir <agent-skill-directory>`, so the
same bundle works without provider-specific forks. See
[fillo.so/agents](https://fillo.so/agents) for setup. The API
commands target
`https://fillo.so` by default (set `FILLO_API` to override).

## Automatic updates

CLI commands check npm's stable release at most once an hour. A newer compatible
CLI runs from a private `~/.fillo/runtime` cache; it does not replace your global
installation or change your project's dependencies. Offline or failed downloads
keep the installed version working. `fillo --version` reports the installed
launcher version without checking the network.

Each invocation also refreshes existing CLI-managed Fillo skills in the current
project and your home directory, including custom destinations registered by
`skill install`. It leaves absent skills, other projects, symlinks, and copies
without `allowAutomaticUpdates: true` untouched. Older CLIs do not roll back
skills installed by a newer CLI. Restart or reload your agent's skill after an
update if it already loaded the previous instructions.

Set `FILLO_AUTO_UPDATE=0` to pin the installed CLI and skill. CI and development
checkouts skip automatic updates. SDK dependencies remain under your project's
package manager. Existing installations need one initial
`npx -y @usefillo/cli@latest skill install` to acquire this update behavior.

## Stage instead of publish

`--stage` creates or replaces a reviewable draft without taking the published
form offline; a plain authenticated `push` publishes ordinary forms directly.
File-request revisions remain staged for review until `fillo publish` is run;
CLI human output and JSON progress report that pending state.

```sh
npx @usefillo/cli push form.json --handle customer-onboarding --stage
```

CI staging with least-privilege sync tokens, pushing a schema from stdin, and
the raw sync endpoint are covered in the CLI guide:
[fillo.so/docs/cli](https://fillo.so/docs/cli). The agent handoff and progress
protocol (`fillo agent event`) live at
[fillo.so/agents](https://fillo.so/agents).

A Fillo browser handoff supplies an `agent bootstrap` command. It installs the
skill and connects the live setup in one run. With `--account`, it also opens
Fillo so the user can approve the exact workspace and project before the agent
continues. The approval screen can create a project inside the selected workspace.
After an ordinary `fillo login`, use `fillo project list`, `fillo project create
<name>`, and `fillo project select <id|slug|unique-name>` to move the local login
deliberately. A handoff login is pinned to its approved project and cannot
enumerate, create, or select sibling projects. Projects isolate forms, keys,
origins, identities, and agent access while members, billing, storage, and usage
totals remain workspace-wide.

## Response destinations from the terminal

Connect Discord — one-click OAuth or a pasted webhook URL — enable it per
form, and mint a connector token for n8n or Zapier, all without a dashboard
trip:

```sh
npx @usefillo/cli discord connect                    # one-click OAuth (needs the deploy's Discord app)
npx @usefillo/cli discord webhook                     # paste a channel webhook URL at a hidden prompt
# non-interactive (agents/CI): FILLO_DISCORD_WEBHOOK_URL=... npx @usefillo/cli discord webhook
npx @usefillo/cli discord enable customer-intake --fields email,plan
npx @usefillo/cli discord status customer-intake
npx @usefillo/cli tokens create-connector --tool n8n  # prints an fcli_ token once
```

`discord enable` also takes `--early-signal 5|10|25|off` (every answered
field for the first N responses) and `--role <guildId>/<roleId>` with an
optional `--auto-join` (grant a connected server's role to a verified
respondent, and add non-members to the server too) — `discord roles
[guildId]` lists a connected server's roles, and `discord disable <form>`
turns a destination off. `--early-signal` and `--auto-join` both send more
than the standing setup; an agent should surface that decision and get its
human's explicit agreement before setting either one. Full reference:
[fillo.so/docs/cli](https://fillo.so/docs/cli).

## Links

- **Docs:** [fillo.so/docs](https://fillo.so/docs)
- **Website:** [fillo.so](https://fillo.so)

MIT licensed.

## CSV exports and shared configuration

`fillo responses export <form> --out responses.csv` replaces the destination only
when the entire export succeeds. It allows up to 30 seconds for response headers,
60 seconds without another body chunk, and ten minutes for the complete export.
Failures preserve an existing destination and remove the temporary sibling file.
Use `--out` with `--json` to reserve stdout for the final result; progress and
errors on stderr are JSON lines. CSV streamed to stdout can be partial if the
connection fails, in which case the command exits unsuccessfully.

The CLI and MCP preserve each other's settings in `~/.fillo/config.json`.
Stored private credentials remain bound to the origin that issued them.
