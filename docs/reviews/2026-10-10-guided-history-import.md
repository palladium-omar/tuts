# Guided work and invoice import

## Changes

- Upload → currency question → row review replaces the open mapping form.
- Currency is chosen once. A real currency column can supply each row's currency; the selected code then applies only to empty currency cells. Currency is absent from the column-correction form.
- The Billing parser supplies detected columns, currency hints, and only observed status labels. The web component submits explicit corrections instead of replaying inferred defaults.
- Status interpretation normalizes Unicode, capitalization, separators, and whitespace. Pending and Sent mean awaiting payment; Draft and Unsent mean unsent; Paid and Settled mean paid. Unknown labels require review or explicit partial import.
- File/sheet changes discard old corrections. Edits disable import until a new preview is ready. Requests are aborted on close/replacement, and automatic opening works under React development effect replay.
- Existing staged/committed previews and financial rows are not rewritten. Original source files and all raw columns remain preserved. No schema migration or new deployed service is required.

## Checks performed

- Web: 25 tests passed; TypeScript passed.
- Billing with local PostgreSQL: 28 tests passed, including tenant isolation, source preservation, partial import, idempotency, and financial arithmetic.
- Cloudflare local runtime: repeated/concurrent XLSX parses, invalid archive limits, malformed ZIP recovery, and the supplied LRM workbook passed. The supplied workbook has 84 valid rows, 3 rows requiring review (11, 13, 55), and 497 template rows skipped.
- Service boundaries passed for ten independent packages.
- Browser interaction used the actual import component and local Billing service with synthetic CSVs. Standard file: EUR inferred, Student Name correctly detected, Pending/pending grouped, three rows imported. Repeating the import retained one committed source with three records.
- Mixed-currency file: EUR and GBP kept separately. Unknown label: one meaning question, preview refresh removed the error. Explicit partial selection enabled import of only the ready row.
- At a 390px viewport, document width remained 390px and modal width 370px. Column correction fields fit; the table scrolls within the modal. Desktop screenshots were reviewed. The temporary local harness was removed before packaging and is not deployed.

## Deployment verification

The release uses the committed static export and updates only the Gateway assets and Billing Worker. The release receipt records current Cloudflare deployment versions, public asset hashes, and anonymous access checks under ignored local release files. Real client data was not committed or imported during browser tests.
