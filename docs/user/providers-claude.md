# Claude

This guide is for people who want to use more than one Claude setup in T3 Code. For Codex, see
[Codex](./providers-codex.md). For first-time setup, see [Install T3 Code](./install.md).

Common reasons:

- use separate work and personal Claude accounts
- try a different Claude Code configuration without disturbing your main setup
- run Claude through a router such as Claude Code Router
- use external providers exposed through a Claude-compatible workflow

## I Only Use One Claude Account

Use the default provider.

Log in with Claude Code normally:

```bash
claude auth login
```

In T3 Code Settings, your Claude provider can stay like this:

```text
Display name: Claude
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

An empty `CLAUDE_CONFIG_DIR path` means T3 Code sets no `CLAUDE_CONFIG_DIR` at all. The Claude Code
process inherits the server's environment and uses its own default config directory, so it sees your
normal login.

> **Do not type `~/.claude` into that field.** Leaving it empty and pointing it at the default
> directory are not the same thing. Setting `CLAUDE_CONFIG_DIR` explicitly changes how Claude Code
> looks up its stored credentials, and the account stops being identified: you stay logged in, but
> the account's email is no longer reported, so T3 Code cannot show you which account the instance is
> using. You can see this for yourself — `claude auth status` returns your email with no prefix, but
> `CLAUDE_CONFIG_DIR=~/.claude claude auth status` returns `"loggedIn": true` with `"email": null`.
> Leave the field empty for your main account.

## Where Claude Skills Are Loaded

T3 Code looks for Claude skills in the Claude config directory's `skills` folder, then
`<workspace>/.agents/skills`, then `<workspace>/.claude/skills`.

If the same skill name exists in more than one folder, the later folder wins.

## I Want Work And Personal Claude Accounts

Give each extra account its own config directory. T3 Code never changes `HOME`.

```text
(leave empty)        work account      Claude Code's own default config dir
~/.claude-personal   personal account  isolated CLAUDE_CONFIG_DIR
```

### Set Up The First Account

Log in normally:

```bash
claude auth login
```

In T3 Code Settings:

```text
Display name: Claude Work
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

### Set Up The Second Account

Log in with a separate config directory:

```bash
mkdir -p ~/.claude-personal
CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login
```

> **Use `CLAUDE_CONFIG_DIR`, not `HOME`.** Overriding `HOME` also moves the macOS login-keychain
> lookup (`$HOME/Library/Keychains`), so the CLI cannot find its stored OAuth credentials and reports
> "Not logged in". T3 Code stopped setting `HOME` for exactly this reason — see the comment in
> `apps/server/src/provider/Drivers/ClaudeHome.ts`. The path you use here must match the path you put
> in the provider's `CLAUDE_CONFIG_DIR path` field.

Confirm the second account landed where you expect, before touching T3 Code at all:

```bash
CLAUDE_CONFIG_DIR=~/.claude-personal claude auth status
```

That prints JSON. You want `"loggedIn": true` and the `"email"` of your _second_ account. Running
`claude auth status` with no prefix should still show your _first_ account — if both print the same
email, the second login did not go into the isolated directory.

Then add another Claude provider in T3 Code — Settings → Providers → the `+` button:

```text
Display name: Claude Personal
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude-personal
```

Type a Display name first: it fills in the Instance ID for you, and the wizard will not let you past
the Identity step until the Instance ID is valid.

### Confirm Both Accounts In The App

Each provider card shows `Authenticated as <email> · <plan>` once its account is detected. Emails are
blurred by default; click a blurred email to reveal it. Comparing the two revealed emails is the only
in-app proof that the two instances really are different accounts.

## How Do I Switch Between Accounts?

Pick the account when you start a thread, from the provider rail in the model picker. Each configured
Claude instance appears as its own entry, so choosing "Claude Personal" instead of "Claude Work"
starts that thread on the personal account. Your choice sticks for subsequent new threads.

## Can I Switch Claude Accounts In An Existing Thread?

No — accounts are chosen per thread, at the start.

Once a thread has started on one Claude account, the other Claude instances are shown greyed out in
the model picker, with the tooltip "<name> is unavailable in this thread. Start a new thread to
switch providers." Their models are removed from the model list too. Start a new thread to use the
other account.

Claude Code keys its login and local state to its config directory — and on macOS to a keychain entry
tied to that directory — so T3 Code treats two different `CLAUDE_CONFIG_DIR path` values as two
different environments rather than trying to share part of the state. This is different from the
recommended Codex setup.

One sharp edge worth knowing: an empty `CLAUDE_CONFIG_DIR path` and an explicit `~/.claude` are
treated as two _different_ environments even though they point at the same account, which is the
other reason not to type the default path into that field.

## I Want To Use OpenRouter

Use this when you want Claude Code to talk to OpenRouter directly, without running a local router.
This is the simplest external-provider setup.

OpenRouter provides a Claude Code integration through Claude's Anthropic-compatible environment
variables.

### Configure A Claude OpenRouter Provider

Add or edit a Claude provider in T3 Code Settings:

```text
Display name: Claude OpenRouter
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude-openrouter
```

In that provider's Environment variables section, add:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive. T3 Code stores the value as a server secret and does not
send it back to the app after saving.

If you want this setup isolated from your normal Claude account, create that config directory first:

```bash
mkdir -p ~/.claude-openrouter
```

If you previously used the same config directory with a normal Anthropic login, log out of it before
using OpenRouter — otherwise Claude Code may keep using cached Anthropic credentials instead of the
OpenRouter token:

```bash
CLAUDE_CONFIG_DIR=~/.claude-openrouter claude auth logout
```

### Pick OpenRouter Models

OpenRouter can route Claude Code's default model roles to OpenRouter model IDs.

Example:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

Add those to the same provider's Environment variables section if you want stable model choices.

### Verify OpenRouter Is Being Used

Open a Claude session and run:

```text
/status
```

You should see the Anthropic base URL set to:

```text
https://openrouter.ai/api
```

You can also check the OpenRouter activity dashboard for requests from your API key.

### Common OpenRouter Mistakes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
- Set `ANTHROPIC_AUTH_TOKEN` to your OpenRouter API key.
- Set `ANTHROPIC_API_KEY` to an empty string so Claude Code does not try to use an Anthropic login.
- Put these variables on the Claude provider instance, not in global shell startup files.

OpenRouter's setup can change over time. Use its upstream Claude Code guide for the current details:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## I Want To Use Claude Code Router

Claude Code Router is useful when you want a local routing layer with more control than a direct
OpenRouter setup.

T3 Code does not need a special Claude Code Router provider. Treat the router as a Claude
environment: give a Claude provider its own `CLAUDE_CONFIG_DIR path`, and put whatever variables
the router tells you to export into that provider's Environment variables section. Mark tokens
and API keys as sensitive.

```text
Display name: Claude Router
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude-router
```

Then copy the variables that `ccr activate` would export into the provider's Environment variables
section. Mark tokens and API keys as sensitive.

If you want the router-backed setup to stay separate from your normal Claude account, create and log
in with a dedicated home first:

```bash
mkdir -p ~/.claude-router
ccr start
ccr activate
CLAUDE_CONFIG_DIR=~/.claude-router claude auth login
```

Claude Code Router's setup can change over time. Use its upstream README for the current install and
configuration steps: <https://github.com/musistudio/claude-code-router>.

## I Want Different Claude Settings, Not A Different Account

Create another Claude provider with the same account if you want a named preset.

Examples:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

If the preset needs different Claude files, give it a different `CLAUDE_CONFIG_DIR path`. If it needs
different API keys, base URLs, or router settings, use Environment variables.

Do not put environment variable assignments in `Launch arguments`.
