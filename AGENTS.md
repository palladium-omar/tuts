# Working agreements

- Preserve separate service processes and databases. No service-to-service source imports or cross-database SQL. Only `@palladium/contracts` and `@palladium/service-kit` are shared backend packages.
- Read `docs/architecture/implementation.md` before coding. Contracts take precedence over convenient shortcuts; propose changes to the coordinating agent before modifying them.
- Use TypeScript, NestJS, PostgreSQL, parameterized SQL and explicit transaction boundaries. Keep money in integer minor units and validate amounts/currencies.
- Enforce tenant scope and backend feature access for every business request. User-provided tenant headers are never proof of membership. Persist events in the same transaction as the state change.
- Payment connectors operate only in sandbox during local development. Do not create production charges, enable live accounts, or contact external users. Cloud deployment requires an explicit user request; the user authorized deployment to tuts.palladiumscholars.com on October 4, 2026.
- Never commit credentials, .env, provider tokens or real client data. Use synthetic demo data only.
- Implement real error handling and persistence. Mark unfinished integrations as unavailable; do not report a mock as a live provider.
- Test tenant isolation, permission boundaries and retry behavior where implemented. Run the affected checks before handoff.
- Delegated agents edit only their assigned paths, do not commit or push, and report changed files, commands run, results, and limitations. Root integrates and publishes.
- Authorized delegation models: GPT-6.1 Sol for service/security work; GPT-6 Luna for bounded documentation/UI tasks. Tool identifiers: `gpt-6.1-sol`, `gpt-6-luna`.
