# Financial reconciliation release

11 October 2026. This receipt covers historical invoice review, student/work
links, receipt matching and fixed dashboard totals. Architecture and the full
data-flow diagram live in [Financial reconciliation](../architecture/financial-reconciliation.md).

## Delivered behavior

- Imported invoices are staged for review. The tutor chooses an existing
  obligation or an additional invoice, links students and a separate payer,
  selects covered work amounts and checks the before/after totals.
- Copies of an invoice become source aliases on one canonical invoice. Original
  documents remain available. Paid work, paid aliases and receipt allocations
  contribute their maximum overlapping claim rather than being summed.
- Recorded work value, invoiced value, recorded paid, verified receipts and
  remaining balances have fixed meanings. An import never switches an entire
  currency from work totals to invoice totals.
- Payments supplies a bounded private confirmed-transaction read. Billing
  projects receipts, supports partial allocations, and distinguishes historical
  bank evidence from provider confirmation and simulated payments.
- Accepted invoices can reopen review to add links or refresh work. Shared work
  snapshots refresh atomically across linked invoices; their revisions appear
  in the preview and are guarded during publication.
- Financial views remain restricted to authorized tutors/business staff.
  Student and parent contexts are denied. Family invoices are labelled shared
  in tutor profiles; the dashboard aggregates each invoice once.
- Clean dashboard and invoice-list reads skip projection writes and locks.
  Identity and payment provider reads occur outside database transactions with
  explicit response, timeout and page bounds.

## Issues caught during review

The final review found and fixed these cases before release:

1. A paid imported alias attached to an unpaid native invoice could lose a paid
   work claim. All financial surfaces now share the same claims calculation.
2. Split work coverage could become impossible to refresh after a work revision.
   Every link refreshes atomically, with aggregate caps and currency checks.
3. A changed form or tenant could outlive a pending preview response. Publication
   uses a frozen decision and preview-derived guards; stale responses are ignored.
4. Split receipt allocations repeated the full refund on tutor profiles. Payment
   rows now group by receipt and invoice before applying refunds.
5. Existing invoices had no path to add covered work. Accepted records now have
   an add/review-links action.
6. A duplicate review did not load the chosen invoice's identities and work.
   Selecting a target now loads its canonical links and correct coverage amounts.
7. The overview reconciliation button led to the native invoice page. It now
   opens reconciliation directly and refreshes the overview after changes.
8. The service month field was difficult to use. It now has separate month and
   year selectors, preserves known periods and rejects incomplete selections.
9. Native projection could overwrite a reviewed period with a blank source value.
   Reviewed values now persist until the native source supplies a known value.

## Validation and deployment

Local validation completed:

- 274 ordinary-role PostgreSQL/service-kit tests, 0 failures or skips.
- 97 web tests, 22 gateway tests, 18 deployment/CSP/output checks, 2 request-schema
  checks, and 9 encrypted-backup/recovery checks passed.
- All workspace type checks and service-boundary checks passed. The controller
  inventory records 203 routes across ten services and is current.
- Dependency audit found no known production vulnerabilities.
- The full static Cloudflare build passed. The workbook Worker regression passed
  repeated/concurrent XLSX, forged-size, archive-limit, malformed-ZIP and recovery
  cases.

The isolated local browser walkthrough imported an invoice CSV, linked student,
payer and €500 paid work, matched another document to the existing invoice, set
September 2026 as its service month, synchronized synthetic confirmed payment
evidence and allocated it in two €250 parts. The final API read verified one
canonical invoice, two aliases, €500 invoiced, €500 verified receipt evidence,
zero invoice balance and zero unmatched receipt amount. Recorded work value and
recorded paid stayed unchanged through review and matching. No live provider was
contacted by that synthetic receipt test.

The Cloudflare dry runs and Pages compilation passed, then all ten domain
Workers, gateway and Pages ingress were published to
`https://tuts.palladiumscholars.com` on 11 October. Verified active versions:

| Worker | Active version (100% traffic) |
| --- | --- |
| Billing | `26e1e074-586c-482d-a631-a0e9303da0cf` |
| Payments | `45d2d197-ed5f-4ef0-b007-d4effe107d47` |
| Reporting | `78bcf3b3-ee49-4bb9-9d8e-1a6feb86af09` |
| Gateway | `4398951a-a06c-47fb-bbbe-174a72040fa0` |

Eight authenticated hosted reads returned 200: CRM student counts, September and
October Billing analytics and Reporting dashboards, student work history, and
accepted/unresolved reconciliation lists. Both dashboard domain sources were
complete. In this concurrent probe the response times were 1.03–2.02 seconds;
these include the local private-binding proxy and are not full browser page-load
measurements. The probe was loopback-only and was stopped afterward.

The public app and health route returned 200. An unauthenticated reconciliation
read with valid business context returned 401 with `Cache-Control: no-store`.
The hosted reconciliation frontend chunk matched the built artifact byte for
byte (42,189 bytes), confirming the new frontend bundle is served in production.
The live page rendered its normal sign-in form; it did not have an authenticated
browser session, so the complete interactive flow was exercised locally rather
than by changing customer production records.

Before/after row digests matched across the eight original Billing/Clients source
tables. The original 84 work rows, 85.5 hours and EUR work totals remained:

| Measure | Preserved amount |
| --- | --- |
| Recorded work value | €6,474.00 |
| Recorded paid | €3,499.50 |
| Pending work | €625.00 |
| Unsent work | €2,349.50 |

New tables retain forced tenant RLS. Production native invoice projection was
initialized by normal reads; the existing USD draft remains separate from EUR
work and contributes no invoiced revenue or verified payment. No imported
customer invoice decisions were automatically published.

Migration `010_financial_reconciliation.sql` was applied on 11 October through
the ordinary Billing role with verified PostgreSQL TLS. It adds nine tables with
forced tenant RLS and amount/identity guards. Dropping the old unique invoice
number index allows duplicate documents to be staged; canonical source identities
and reviewed decisions enforce deduplication.

## Limits

Bank-statement file parsing and automatic PDF/OCR amount extraction remain
unsupported. PDF files can be archived and paired with manual invoice entry.
Name/amount/date suggestions do not automatically publish financial decisions.
Current reviews add links and refresh covered amounts; removing associations and
replacing already known payer/dates require a separate correction workflow.
Provider charges, refunds and customer emails were not sent during this release.
Synthetic confirmed receipt evidence exercises matching, not live processor
confirmation. This feature adds no new hosting product or paid subscription.
