# XLSX upload runtime correction

## Observed failures

The reported workbook was a valid ZIP archive. Local Node tests passed, but the
Cloudflare runtime threw `Memory limit exceeded` while synchronously expanding
an 82,608-byte worksheet with `maxOutputLength`. Both CRM and Billing translated
this into `Workbook entry exceeds its declared size or cannot be expanded`.
Testing only in Node missed the deployment-runtime failure.

Fixing expansion revealed a separate repeated-request failure. An isolated
synthetic reproduction of the browser ExcelJS bundle showed six callbacks left in
its embedded browser process queue after the first response. The second request
appended a seventh callback but did not restart the queue, and Workers canceled it
as unable to complete. Explicit Node entry resolution fixes warm requests.

## Changes

- Shared bounded streaming raw-deflate helper; exact-length and archive-wide
  checks remain owned by each service.
- Asynchronous validation awaited by both import paths.
- ExcelJS Node entry selected only for Clients and Billing Workers.
- Worker regression executed in CI, with synthetic compressed workbooks,
  repeated/concurrent requests and rejected-archive recovery.

## Validation

The original workbook passed both full parsers in local workerd, repeatedly and
concurrently. It also passed both parsers repeatedly in Cloudflare's remote
preview runtime, with no database/storage bindings: 84 valid work entries and
three requiring review (worksheet rows 11, 13 and 55). No client or financial
records were imported into production during verification.

The helper tests cover exact/empty lengths, truncated/corrupt deflate, invalid
limits and a 20 MB highly compressed entry with a falsely declared small size.
Service type builds, Clients tests, Billing parser tests, shared runtime tests,
deployment configuration tests and service boundary checks passed. Both production
Worker bundles passed deployment dry runs. Production rollout receipts are saved
privately alongside the runtime verification evidence.
