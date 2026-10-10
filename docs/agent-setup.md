# Cloudflare and Neon agent setup

> The table below is a historical tooling/authentication snapshot. For the current ten-service deployment, live delivery flags and verification limits, read the [documentation index](README.md) and [10 October audit](reviews/2026-10-10-platform-audit.md). A browser session never proves CLI/API access.

## Status on October 4, 2026

Official Cloudflare and Neon guidance is installed, and the MCP server URLs are
registered in the local agent configuration. Registration and skill installation
do not authenticate an account or grant deployment access.

| Component | Installed or registered | Authentication status |
| --- | --- | --- |
| Cloudflare skills | 16 skills installed globally under `~/.agents/skills/` from the official Cloudflare repository | Skills need no account credentials |
| Neon skills | `neon` and `neon-postgres` installed locally under `.agents/skills/` using the requested `npx` setup | Skills need no account credentials |
| Cloudflare MCP | Main API, documentation, bindings, builds, and observability servers | No OAuth grant completed |
| Wrangler CLI | Project-local credentials under `.cloudflare/cli-config/` | Authenticated; all 12 event queues and the Pages project were created through the CLI |
| Neon MCP | Pinned to existing project `divine-poetry-44729356` with selected tool categories | No OAuth grant completed |
| Neon CLI | Available through the local npm cache; its default profile has no saved account credentials | Unauthenticated |
| Neon PostgreSQL | Existing project connection saved only in ignored private deployment settings | All eight service schemas and original owned-workspace records restored with verified TLS and restricted roles; cross-service database access denied; copied rows verified against the private snapshot |
| Deployment | All nine Workers and Pages deployed; primary origin `tuts.palladiumscholars.com` | Custom hostname homepage, `/health`, and unauthenticated session endpoint return HTTP 200 with valid TLS; HTML request for `/?view=scheduling` redirects canonically to the custom hostname; signup/sign-in and authenticated flows remain unverified |

An existing signed-in provider dashboard is a separate browser session; it does
not establish CLI or MCP authentication. Confirm access through the specific
tool before reporting that it can operate the account.

## Official skills

The [Cloudflare skills repository](https://github.com/cloudflare/skills) provides
the installed guidance. To reproduce the global skills installation for Codex:

```sh
npx --yes skills add cloudflare/skills --skill '*' --global --agent codex --yes
```

The local Neon installation contains its overview and PostgreSQL skills. From
the repository root, the official CLI can install those two skills explicitly:

```sh
npx --yes neon@latest skills -s neon -s neon-postgres -y
```

The absence of `--global` keeps this Neon installation local to the project.
Consult the [official Neon skills source](https://github.com/neondatabase/agent-skills)
and [CLI skills reference](https://neon.com/docs/cli/skills) for installation and
update options. Start a new agent session when needed for it to discover newly
installed guidance and registered tools.

## Registered MCP servers

These are stable server endpoints, not temporary OAuth authorization links:

| Local server name | Endpoint |
| --- | --- |
| `cloudflare` | `https://mcp.cloudflare.com/mcp` |
| `cloudflare-docs` | `https://docs.mcp.cloudflare.com/mcp` |
| `cloudflare-bindings` | `https://bindings.mcp.cloudflare.com/mcp` |
| `cloudflare-builds` | `https://builds.mcp.cloudflare.com/mcp` |
| `cloudflare-observability` | `https://observability.mcp.cloudflare.com/mcp` |
| `Neon` | `https://mcp.neon.tech/mcp?category=projects&category=branches&category=schema&category=querying&category=observability&category=docs&projectId=divine-poetry-44729356` |

The Neon configuration exposes the `projects`, `branches`, `schema`, `querying`,
`observability`, and `docs` categories for that existing project. A project pin
filters the MCP tools' targets; it does not by itself reduce an OAuth grant or
the underlying API key's permissions. Tool registration also does not imply
that every tool is visible in a session started before registration.

See [Cloudflare's official MCP server directory](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)
and the [Neon MCP configuration reference](https://neon.com/docs/cli/mcp).

## Credential-safe authentication

### Cloudflare

Use the agent client's authentication action for the registered server and
review the requested account and permissions. Authorize the intended account
and the capabilities needed for this deployment. A completed MCP grant and
Wrangler CLI authentication are separate credentials and must be checked
separately.

Wrangler authorization completed in Codex's isolated browser after the account
owner signed in and instructed continuation through the CLI. Keep all provider
browser work in that isolated browser so it does not interrupt personal Chrome
browsing. The successful grant includes account/user read, Workers and script
write, Worker tail read, Pages write, Queues write, and background access.

Use the project-local credential directory for deployment commands:

```sh
XDG_CONFIG_HOME="$PWD/.cloudflare/cli-config" pnpm exec wrangler whoami
XDG_CONFIG_HOME="$PWD/.cloudflare/cli-config" node scripts/cloudflare.mjs provision
```

R2 is active. The owner approved its displayed free allowance and usage-based
overage terms and completed the required billing checkout. Both private buckets
are provisioned; public bucket access is disabled and transport payloads expire
after seven days. The Workers plan was not upgraded.

For CLI access, follow [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/commands/#login)
or use a purpose-scoped API token stored in the environment. Token setup is
documented in [Cloudflare API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).
Keep tokens out of command arguments, tracked configuration, logs, and browser
application bundles. `pnpm exec wrangler whoami` is the CLI's account check;
its result does not authenticate any MCP server.

### Neon: scope access to the existing project

For the current deployment, the existing direct PostgreSQL connection was
retrieved from the authenticated Console and saved privately in
`.cloudflare/secrets.json`. It is sufficient for the deployment script's SQL
migrations; account API access is not required for those operations. Do not
print, commit, or place this administration connection in Worker configuration.

If account API operations are needed later, prefer a **project-scoped API key** for
`divine-poetry-44729356`. In the already authenticated Neon Console, use the
organization's **Settings → API keys → Create new → Project-scoped**, then select
that project. These keys have Editor access within the chosen project. They can
modify and delete resources inside it, but cannot delete the project, create
other projects, perform organization actions, or manage project access.
[Neon API key scopes](https://neon.com/docs/manage/api-keys).

Store the resulting key in a credential manager or an environment variable
named `NEON_API_KEY`. Import an existing key through stdin into a new CLI profile
when a saved profile is preferred:

```sh
# Supply the existing project-scoped key through a secure stdin source.
npx --yes neon@latest profile create tuts-project --api-key -
npx --yes neon@latest profile list -o json
```

Select that profile explicitly with `--profile tuts-project` for subsequent
commands. A profile row with `account: "-"` and `file: "missing"` is not an
authenticated account. An API key can also authenticate the registered Neon MCP
server; use a credential environment reference supported by the client instead
of writing the key into tracked MCP configuration. See [Neon CLI authentication](https://neon.com/docs/cli/login)
and [Neon MCP connections](https://neon.com/docs/ai/connect-mcp-clients-to-neon).

Automatic approval review rejected the attempted Neon CLI browser authorization
because it requested broad organization create, update, and delete permissions.
That flow did not complete. A project selection for a subsequently minted key
does not narrow the initial browser grant; do not use minting as a workaround
for the rejected authorization. Reuse an existing permitted credential or obtain
the project-scoped key directly through the Console.

### Complete OAuth in the originating browser profile

Start and finish an OAuth attempt in the same browser profile, preserving its
cookies and the client's pending authorization state. Open the original
generated authorization URL unchanged. Transferring an intermediate consent
page URL to another browser or profile can lose the required state and cause
`invalid_request`.

Keep temporary authorization URLs, state values, codes, and tokens out of this
document and shared artifacts. If an attempt has lost its browser state, start
a fresh permitted flow and complete it in its originating profile.

## Preserve the deployment boundaries

Tool setup grants no permission to replace the existing Neon project or combine
the ten services' data. Deployment keeps separate PostgreSQL databases and
roles for Platform, Clients, Scheduling, Learning, Billing, Payments,
Notifications, Integrations, Planning and Reporting, with tenant RLS enforced in each service.
The existing BetterAuth implementation remains the identity provider.

Use pooled connections for Worker application traffic and direct connections
for migrations, following [Neon connection pooling](https://neon.com/docs/connect/connection-pooling).
Keep administration credentials local; each Worker receives only its own
service database credential. Installation, authentication, resource provisioning,
migration, deployment, and a verified hosted app are distinct completion steps.
The repository's Cloudflare deployment guide describes the implementation and
remaining deployment work.
