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

## Links

- Setup for every agent: https://fillo.so/agents
- Documentation: https://fillo.so/docs
- Privacy: https://fillo.so/legal/privacy
- Support: hello@fillo.so
