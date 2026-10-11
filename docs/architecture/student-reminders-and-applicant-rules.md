# Student reminders and applicant rules

This extension keeps the existing ten services, Cloudflare Workers schedules, PostgreSQL databases and student permission model. No new hosting product is required.

## Ownership and communication

| Capability | Owner | Interface |
| --- | --- | --- |
| Homework and attached documents | Learning | Existing student-scoped assignment detail and submission APIs |
| Boards, task dates and application rules | Planning | Versioned templates, personalized preview and student-scoped board/card APIs |
| Approved education/applicant profile facts | Clients | Validated profile update and whitelisted portal response |
| Reminder schedule, inbox, attempts and preferences | Notifications | Student-scoped reminder APIs; scheduled callback in the existing Notifications worker |
| Current account email and portal grants | Platform | Private authenticated reminder-recipient resolution |
| Portal navigation and guided questions | Web | Composes the APIs; never reads databases |

Reminders belong to the authenticated account, business and student. Creating a reminder validates the referenced homework or shared planning task through its owning service using the current signed context. The client provides a resource identifier and reminder time, never a recipient email or arbitrary outbound URL. Notifications stores a bounded title snapshot and builds a fixed portal link. Delivery rechecks active portal access through Platform; revocation prevents email delivery. Tenant RLS, user ownership, explicit read/write permissions and student scope apply to every inbox action.

The existing fifteen-minute Cloudflare schedule advances due reminders. Persist delivery leases and stable idempotency keys before outbound work; cap each tick, avoid overlapping attempts, distinguish provider acceptance from inbox delivery, and expose failure states. Email is optional and off until explicitly selected. The existing restricted system sender is reused; tenant campaigns and password recovery remain separate. In-app reminders continue to work when email is unavailable. Do not log addresses, tokens or message bodies. Completion/archive events suppress reminders when their payload proves the referenced work no longer needs attention; events must not grant access. Planning card events add `completed:boolean`, derived from the same trimmed Done/Completed/Complete column labels as Overview. Column status renames increment affected card revisions and emit fresh status evidence. Planning card detail adds `columnKind` for creation validation. Suppression depends on eventual event delivery; delivery rechecks current membership, student grants, permissions and enabled features through Platform, without persisting the user’s signed token. See [Notifications delivery limits](../../services/notifications/README.md).

## Direct homework navigation

`/portal?business=<UUID>&student=<UUID>&section=homework&assignment=<UUID>` opens exactly one authorized assignment using Learning's detail API, even when it is outside the first list page or hidden by a status filter. The reminder link fixes the owning business as well as student and assignment; query values are validated. Closing the dialog clears only the assignment parameter. Back/forward navigation and student changes discard stale requests; a failed or inaccessible link does not expose another student's data. Overview, reminders and planning tasks referencing homework use this same route.

## Applicant procedure and eligibility

Template definitions remain immutable. New country-aware releases do not silently change existing boards. A board records its confirmed applicant facts and the rule/template version used to create it. Country of residence, citizenship, qualification, entry level, selected application route and USA course procedure have distinct meanings. Unknown facts prompt a short guided question; they are never inferred from names, email addresses, business country or tutor location.

Campus France is a template family. Its procedure selection uses country of residence together with citizenship/qualification/entry level where relevant. Country calendars are separate, sourced records, with explicit cycle, applicability, date/time zone, verification date and official links. Countries without a verified calendar receive useful tasks and official country guidance, with deadlines marked for confirmation. A Morocco date must never be reused for another country. French/EU and French-baccalaureate routes require official route guidance rather than being treated as the same international procedure.

US financial-aid rules distinguish federal eligibility from institutional aid requirements. FAFSA is not limited to US citizens; eligible noncitizens may qualify. CSS Profile is required only by participating institutions and is not a universal substitute for FAFSA. Both, neither or an eligibility-review task may apply. Conditional tasks derive from explicitly confirmed eligibility and selected institutional requirements; unknowns remain visibly unresolved.

## Applicant API contract

The gateway prefixes these routes with `/api/planning`. Template and country reads require `planning.read`; instantiation requires `planning.write`, `clients.read`, the Clients entitlement and successful student validation. All template database access uses the current tenant transaction. Submitted applicant facts select requirements; they do not grant student or template access.

| Route | Request | Response |
| --- | --- | --- |
| `GET /v1/applicant-countries` | None | `{items:[{code,guidanceUrls}]}` — 249 ISO country choices with official guidance |
| `POST /v1/templates/:key/preview` | `{version,applicantFacts}` | `{item,definition,applicantFacts,questions,ready,ruleVersion}`; `item.definition` is the personalized definition |
| `POST /v1/templates/:key/instantiate` | Existing creation body with expanded applicability below | Existing board detail and idempotent replay response; cards recomputed by Planning |

A question is `{key,prompt,options:[{value,label}]}`. The wizard shows the first missing question and requests another preview after each answer. Country and citizenship options come from the country catalog; citizenship accepts multiple explicitly confirmed countries. The UI converts the `aidSeeking` option to a boolean. The optional **Review applicant details** step exposes current/saved answers with individual Change actions. Changing residence, citizenship, qualification or study level clears the previous route and USA course procedure, and requests a fresh server preview. Changing the application route also clears the course procedure. USA Études en France then asks `campusFranceProcedure`: HDAP means connected Licence 2/3 or Master’s courses excluding architecture and art; DAP covers public-university first year and architecture at every level. Art/other and unknown choices produce a procedure-review task with no verified calendar. HDAP with first-year entry is incompatible and Planning rejects instantiation. Failed template/country loads expose an explicit retry action. Unknown US eligibility or requirements can be confirmed as `unknown`; the resulting plan contains a review task and does not assert the missing filing requirement.

Clients adds a strict, approved `planningProfile.applicantFacts` object:

| Field | Values |
| --- | --- |
| `residenceCountry` | ISO country code |
| `citizenshipCountries` | Unique array of 1–10 ISO codes |
| `qualification` | `french_baccalaureate`, `european_baccalaureate`, `other` |
| `entryLevel` | `first_year`, `later_undergraduate`, `masters`, `doctorate` |
| `applicationRoute` | `etudes_en_france`, `parcoursup`, `dap`, `direct`, `mon_master` |
| `campusFranceProcedure` | `hdap`, `dap`, `other`, `unknown`; optional approved fact, required confirmation for USA Études en France |
| `aidSeeking` | Boolean |
| `federalAidEligibility` | `eligible_citizen`, `eligible_noncitizen`, `ineligible`, `unknown` |
| `cssProfileRequired`, `satRequired` | `required`, `not_required`, `unknown` |
| `satAccommodations` | `requested`, `not_requested`; no diagnosis or documents |

These keys are optional while facts are being gathered. The portal whitelist shares only approved education fields and this validated nested object; legacy staff-only `applicantCountry` and `templateKey` remain excluded. Existing education edits preserve approved applicant facts. The wizard prefills the approved facts; students confirm board-specific answers, while authorized staff may explicitly choose to save confirmed answers through Clients before creating the board.

New dynamic releases require `applicability.applicantFacts` and the preview’s `ruleVersion`. Country-aware Campus France additionally requires `applicability.applicantCountry` to equal confirmed residence and `applicability.applicationRoute` to equal the selected nested route. Definition fields `cycle,country,applicantCategory,program,round` must still match exactly. Planning recomputes the personalized definition, rejects required unanswered questions or an invalid route, and persists the confirmed applicability snapshot with actor/time. The client cannot supply cards or verification status.

The initial rule revision is `2026-10-11.1`. `campus-france-<cycle>` v1 is the country-aware family. Common App uses v4 for 2027 and v3 for later cycles. Historical Common App and Morocco releases retain their definitions; the guided template list omits the Morocco-specific family, while explicit version/detail and existing boards remain available. Review uses the board’s saved facts. If a new dynamic release requires facts missing from an older board, Planning requires a new personalized board rather than silently assigning eligibility. Existing opt-in date/task/resource reviews retain their preservation rules.

## Researched country and calendar limits

The ISO catalog is a country chooser and official guidance directory. It is **not** 249 researched admissions calendars. This release researched local France, USA and Morocco procedures, plus central European/baccalaureate and Mon Master eligibility. Country coverage choices use official Ministry guidance, with local-office confirmation required for any disputed coverage or institution exception.

| Confirmed residence and route | Cycle | Current calendar treatment |
| --- | --- | --- |
| Morocco; eligible connected Études en France/DAP candidature | 2027 entry | November 15, 2026 at 23:59 Morocco time, stored with `Africa/Casablanca` and reviewed UTC conversion |
| USA; explicitly confirmed connected Licence 2/3 or Master’s HDAP, excluding architecture/art | 2027 entry | January 15, 2027 at 18:00 EST, stored with `America/New_York` |
| USA explicitly confirmed DAP (public-university first year or architecture at every level); France-resident first-year dossier vert DAP | 2027 entry | December 15, 2026 is source-supported as a closing day; cutoff time remains unverified, so `dueAt:null` and `requires_confirmation` |
| USA other/unconfirmed course procedure; Parcoursup, Mon Master, direct application, other countries or later cycles | Any | Useful official guidance/tasks; no verified deadline is imported from another route, country or cycle |

French/European citizenship and French/European Baccalaureate first-year facts select appropriate Parcoursup guidance and require confirmation of participating courses or a documented direct exception. Master selection distinguishes Mon Master eligibility from Études en France coverage; doctoral applications use institution/doctoral-school guidance, with a USA-only confirmed architecture DAP exception available through Études en France. Selected routes still need course, exemption and any parallel-process confirmation. The [annual source register](../annual-review.md) provides sources, dates, exact scope and change triggers.

## Annual review and verification

The [annual source register](../annual-review.md) records every manually maintained calendar, deadline, timeline and requirement, its scope, source, current verification date, next review trigger, and code location. Review new entry cycles before publishing verified dates. Suggested preparation dates remain labelled suggestions. Institution-specific requirements are confirmed with the institution. Changed rules publish a new version and use the existing opt-in template review mechanism.

Verification covers tenant/account isolation, revoked grants, duplicate schedule ticks and provider retries, direct links across filtered/paginated lists, country selection, unknown eligibility, and preservation of existing boards. Real Cal.com and Google Docs checks must record the actual provider outcome separately from local synthetic checks.
