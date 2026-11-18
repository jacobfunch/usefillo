# Fillo plugin

Build forms inside your product with your coding agent. Fillo renders native
forms in React, Next.js, Vue, Svelte, Astro, or plain HTML, and handles
validation, file uploads to your own storage, responses, and delivery to
webhooks and integrations.

This plugin adds two things:

- **Build with Fillo skill** — how to add, style, publish, and verify a Fillo
  form in the app you are working on.
- **Fillo MCP server** (`https://fillo.so/api/mcp`) — publish forms and read
  responses from the agent. The first time you use it, sign in to Fillo in the
  browser; that also creates your account.

## Install

Claude Code:

```text
/plugin marketplace add jacobfunch/usefillo
/plugin install fillo@fillo
```

Any other agent that reads Agent Skills:

```bash
npx @usefillo/cli@latest skill install
```

Then ask your agent to add a Fillo form to your app.

## Update

In Claude Code, open `/plugin`, select Fillo on the Installed tab, and choose
**Update now**. From a terminal, run `claude plugin update fillo@fillo`.
After a terminal update, run `/reload-plugins` in an existing Claude Code
session or start a new session.

For a Codex Git marketplace installation, run
`codex plugin marketplace upgrade fillo`. Plugins installed from the OpenAI
directory use its published version. Restart the desktop app after a local
marketplace update, then start a new chat to load the current skill and tool
definitions.

Existing hosted MCP connections use the current server at the same URL. Fillo
honors their granted publication policy; a pending owner approval is saved
under **Settings → Agents**, even after its single-use link expires. The skill
explains how to check its status and continue without repeating the action.

The optional `fillo_send_feedback` tool sends product feedback to the Fillo
team. Exclude secrets and respondent data. Feedback does not block form work.

## Links

- Setup for every agent: https://fillo.so/agents
- Documentation: https://fillo.so/docs
- Privacy: https://fillo.so/legal/privacy
- Support: hello@fillo.so
