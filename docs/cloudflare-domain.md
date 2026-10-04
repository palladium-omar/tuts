# Tuts Pages custom hostname

Use this after `https://tuts-palladium.pages.dev` is healthy. The helper reads the validated account ID and Pages project from ignored `.cloudflare/deployment.json`; the manifest must use `ingress: "pages"`. Its only allowed hostname is `tuts.palladiumscholars.com`. It can run while the manifest still uses the staging URL.

Wrangler credentials are captured in memory using the project's `.cloudflare/cli-config` as `XDG_CONFIG_HOME`. The helper never prints the credential or full provider errors. It requires existing authentication with Pages write permission for `attach`/`retry`, or Pages read/write permission for `status`. It does not initiate login or refresh expired OAuth credentials. Wrangler 4.147.0 has no Pages custom-domain subcommand; the helper uses the official REST API.

## Associate and check

Run from the repository:

```sh
node scripts/cloudflare-domain.mjs attach
node scripts/cloudflare-domain.mjs status
```

`attach` lists existing project domains before adding the hostname, so repeated calls reuse the existing association. Output contains only the hostname and concise domain, validation, and verification statuses. `status` is read-only. If DNS is correct but validation needs another attempt:

```sh
node scripts/cloudflare-domain.mjs retry
node scripts/cloudflare-domain.mjs status
```

The helper calls these paths beneath `https://api.cloudflare.com/client/v4`:

| Command | API request |
|---|---|
| `attach` | `GET /accounts/{accountId}/pages/projects/{pagesProject}/domains`, then `POST` the same path with `{"name":"tuts.palladiumscholars.com"}` if absent |
| `status` | `GET /accounts/{accountId}/pages/projects/{pagesProject}/domains/tuts.palladiumscholars.com` |
| `retry` | `PATCH` the status path |

[Associate a Pages domain](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/create/), [read validation status](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/get/), [retry validation](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/edit/), [Wrangler Pages commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/).

## GoDaddy DNS

Associate the hostname with Pages **before** adding DNS. A CNAME alone can return 522. GoDaddy remains authoritative; this subdomain does not require moving the zone's nameservers. The helper never changes DNS. [Pages external DNS procedure](https://developers.cloudflare.com/pages/configuration/custom-domains/#add-a-custom-cname-record).

GoDaddy account access or authorized DNS API credentials are required to add exactly this record:

| Type | Name | Target | TTL |
|---|---|---|---|
| CNAME | `tuts` | `tuts-palladium.pages.dev` | 600 seconds |

Confirm the actual project's `pages.dev` hostname before adding the record. Preserve the Firebase apex and `www` records, Google mail MX records, and all existing verification/SPF/DKIM/DMARC records. For authorized API use, `PUT /v1/domains/palladiumscholars.com/records/CNAME/tuts` with `[{"data":"tuts-palladium.pages.dev","ttl":600}]` affects only that name/type; do not use the whole-zone record replacement endpoint. [GoDaddy record-specific endpoint](https://developer.godaddy.com/en/docs/references/rest/domains/v1/record-replace-type-name).

After DNS resolves and Pages reports `active`, switch application/auth origins and redeploy:

```sh
node scripts/cloudflare.mjs init --ingress pages --pages-project tuts-palladium --custom-domain tuts.palladiumscholars.com --public-url 'https://tuts.palladiumscholars.com'
node scripts/cloudflare.mjs config
node scripts/cloudflare.mjs deploy
```

The manifest change preserves existing credentials. It does not itself associate a Pages domain or change DNS. Confirm HTTPS and the ordinary browser authentication flow on the custom hostname before reporting deployment complete.
