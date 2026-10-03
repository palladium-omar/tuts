# Live UI review — 3 October 2026

Three agents used the running local website in separate browser tabs, implemented fixes, and revisited the changed flows. The coordinating agent reviewed navigation and phone layouts. All created records belong to the synthetic `Tuts UX — CRM`, `Tuts UX — Teaching`, and `Tuts UX — Setup` businesses in the local development database.

## Findings and changes

| Area             | Observed friction                                                                                   | Change                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Navigation       | Reload returned to Overview and lost the selected business; Back did not follow feature navigation. | Business, view, and connector category now live in the URL. Reload, Back, and Forward restore them.                     |
| Phone navigation | Navigation consumed most of the first screen and hid Add a business.                                | Collapsible Menu with all workspace actions, current-page semantics, visible keyboard focus, and a skip link.           |
| CRM              | A filtered empty result looked like an empty database; Edit was offscreen on phones.                | Clear search/filters, contextual empty states, and stacked mobile contact cards with a visible Edit action.             |
| Contact forms    | Blank names exposed technical validation text.                                                      | Plain-language guidance, name validation, field limits, and focus on the first editable field.                          |
| Imports          | Mapping remained above the preview, obscuring the review and import action.                         | Choose, match, and review steps; filename and sample values; clear duplicate counts; explicit email-column requirement. |
| Learning         | Empty Student selector gave no next step; assignment cards lacked student names.                    | CRM prerequisite guidance and navigation, student names, clearer progress labels, and work/feedback in the detail view. |
| Attachments      | Re-selecting a file could add it twice; tiny files displayed as zero MB.                            | Duplicate selection filtering, readable sizes, and upload progress text.                                                |
| Invoices         | Draft/issue actions and amounts lacked context; long dialogs hid actions.                           | Currency/total preview, amount validation, draft explanation, dates/reference, balance due, and sticky dialog actions.  |
| Business setup   | Long profile form and read-only hex values made customization cumbersome.                           | Separate details and appearance sections, editable hex values, selected preset feedback, and invoice sender preview.    |
| Connectors       | Setup requirements and sync expectations were easy to miss.                                         | Visible credential requirements, setup steps, sync scope explanation, and refresh feedback.                             |

## Manually exercised

- Create and edit synthetic contacts; search, stage filters, clear filters, blank-name validation, and cancellation.
- CSV and XLSX import through the actual upload form, column matching, duplicate skip/update previews, missing-email handling, and successful import. CSV fixture: one new contact and two skipped rows. XLSX fixture: one new contact.
- Phone CRM at 390 px, including opening Edit from a contact card.
- Upload a synthetic text worksheet; save an assignment; record work; request another attempt; record revised work; complete the assignment. Re-selecting the same file leaves one attachment.
- A workspace with no students shows Add a student first; Open CRM navigates to that workspace's CRM.
- Save a synthetic invoice draft, review it, issue it, and reopen it. Preview a different currency and cancel before saving.
- Save a synthetic business logo, invoice details, address, palette preset, and custom hex color. Reload preserves the saved profile. Invalid hex input is rejected.
- Open Calendly and Cal.com setup dialogs and inspect their requirements without supplying credentials.
- Reload a selected section and business; use Back and Forward across sections and businesses; follow the Sessions-to-calendar-connectors shortcut.
- Phone navigation opens, closes after selection, exposes all features, and does not cause page overflow.

## Composition behavior

The shell owns `business`, `view`, and optional connector `filter` query parameters. It resolves businesses against the signed-in membership list and views against feature entitlements. These parameters select a screen; all data requests still use the gateway and service authorization checks. Each feature retains its existing service API. Learning's optional `onOpenClients` callback asks the shell to open CRM without importing CRM implementation code.

## Review limits

Build checks passed: `pnpm --filter @palladium/web typecheck`, `pnpm --filter @palladium/web build`, and `git diff --check`.

No external calendar credentials were provided, so this pass does not establish successful synchronization with a live Calendly or Cal.com account. No payment was made. Attachment upload and display were confirmed, but the browser download-completion event timed out; download completion and printing remain unverified. No automated test suite was added or run in this UI review.
