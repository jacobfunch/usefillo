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
  <a href="https://www.npmjs.com/package/@usefillo/mcp"><img src="https://img.shields.io/npm/v/@usefillo/mcp" alt="npm version" /></a>
  <img src="https://img.shields.io/npm/l/@usefillo/mcp" alt="MIT license" />
</p>

The [Fillo](https://fillo.so) MCP server. It gives a coding agent the full Fillo
loop — provision a workspace, scaffold a form into the host repo, publish it, and
query its responses — without leaving the session, authenticated exactly like a
human CLI user.

## Install

One click, if your editor supports it:

[![Add to Cursor](https://img.shields.io/badge/Add_to_Cursor-black?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=fillo&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB1c2VmaWxsby9tY3AiXX0=)
[![Add to VS Code](https://img.shields.io/badge/Add_to_VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](vscode:mcp/install?name=fillo&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40usefillo%2Fmcp%22%5D%7D)

Claude Code:

```sh
claude mcp add fillo -- npx -y @usefillo/mcp
```

Any other MCP client: run `npx -y @usefillo/mcp` over stdio. Set `FILLO_API` to
point at a non-production deployment.

## Credentials

The server reads the same credentials the CLI writes to `~/.fillo/config.json`,
or from the environment:

- `FILLO_TOKEN` — a `fcli_…` login token (from `npx @usefillo/cli login`).
  Authenticated tools (`fillo_list_forms`, `fillo_publish_form`, and trusted
  pushes to a claimed workspace), plus local project selection with an ordinary
  login. File-request pushes remain draft/staged for review.
- `FILLO_PK` — a `pk_…` publishable key. `fillo_provision_workspace` mints one
  and saves it for you.
- `FILLO_API_KEY` — a `fsk_…` project API key, minted in **Settings →
  Connections** of a claimed workspace. Required by the response tools.
- `FILLO_API` — overrides the origin (default `https://fillo.so`).
- `FILLO_CONFIG_DIR` — overrides the config directory (default `~/.fillo`).

The server never prints login tokens, API keys, or claim tokens into the
transcript. The `pk_` publishable key is safe to surface (it lives in browser
code), so `fillo_provision_workspace` returns it for you to wire into the app's
public env. Provisioning also makes that temporary project the active local MCP
context, so an older saved account login cannot receive the next push. Selecting
a project switches the context back to the account.

## Tools

| Tool | Auth | What it does |
| --- | --- | --- |
| `fillo_provision_workspace` | none (needs an email) | Create an unclaimed preview workspace, return its `pk_` key and caps, and email its claim link. |
| `fillo_whoami` | login token or `pk_` | Report the active credential, workspace, and project. |
| `fillo_list_projects` | ordinary login token | List projects in the current workspace and mark the current selection. |
| `fillo_create_project` | ordinary login token | Create and select an isolated project and save its `pk_` key. |
| `fillo_select_project` | ordinary login token | Select by id, slug, or unique exact name and update local project state. |
| `fillo_push_form` | login token or `pk_` | Create or update a form and publish by default; set `publish: false` with a login token for explicit review workflows. Storage-blocked file requests remain draft. |
| `fillo_publish_form` | login token | Take a draft or staged changes live after review; return the exact storage setup link when blocked. |
| `fillo_list_forms` | login token | List the project's forms. |
| `fillo_get_form` | none (published) | Fetch a published form's schema, theme, and capabilities. |
| `fillo_search_examples` | none | Search the curated Fillo example library. |
| `fillo_docs` | none | Fetch a Fillo docs page as Markdown by topic. |
| `fillo_list_responses` | `fsk_` API key | List a form's responses (claimed workspaces only). |
| `fillo_get_response` | `fsk_` API key | Fetch one response (claimed workspaces only). |
| `fillo_response_summary` | `fsk_` API key | Summarize a form's responses without reading every row (claimed workspaces only). |
| `fillo_claim_status` | `pk_` | Report the provisioned workspace's caps and claim deadline. |

There are no delete tools. Write annotations still use the conservative
worst-case hint because a push can replace draft state and a publish can replace
the public schema. Every tool is a thin wrapper over Fillo's public HTTP API —
the server never touches the database and imports no app code, so workspace
scoping, rate limits, and validation stay in one place.

The three project tools are local-only and require the general token minted by
`fillo login`. A project-specific handoff and a hosted remote-MCP OAuth grant
remain pinned to the project a human approved. Selecting locally also clears
cached preview and `fsk_` state from the prior project; replace any
`FILLO_PK` or `FILLO_API_KEY` environment overrides yourself.

Projects are sites/apps beneath one billed workspace. They isolate forms,
publishable/API keys, allowed origins, respondent identities, and agent
authority. Workspace membership, billing, storage connections, and usage totals
remain shared.

## Links

- **Docs:** [fillo.so/docs](https://fillo.so/docs)
- **Website:** [fillo.so](https://fillo.so)

MIT licensed.
