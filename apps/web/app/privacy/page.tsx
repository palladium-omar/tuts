import type { Metadata } from "next";
import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "Privacy notice · Tuts",
  description: "How Tuts accesses, uses, shares, stores, and protects Google Calendar data.",
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <article className={styles.notice}>
        <header className={styles.header}>
          <a className={styles.wordmark} href="/" aria-label="Tuts home">tuts</a>
          <p className={styles.updated}>Last updated: October 14, 2026</p>
        </header>

        <h1>Privacy notice</h1>
        <p className={styles.lead}>
          This notice explains how Tuts handles Google Calendar data when you connect a calendar to your tutoring workspace.
        </p>

        <section>
          <h2>What Tuts accesses</h2>
          <p>
            If you connect with Google sign-in, Tuts requests read-only access to your Google Calendar event data and calendar list. You choose one readable calendar. Tuts syncs event details needed to show sessions in your workspace, such as titles, times, cancellations, attendee details supplied with an event, and an event link when available. Sync covers a rolling period of 90 days in the past and 180 days ahead, subject to a limit of 2,000 events per sync.
          </p>
          <p>
            To keep previously synchronized sessions accurate, Tuts can also check a limited number of those events individually, including an event moved outside that rolling period. Connector sync snapshots are retained while the connection is active to identify changes, cancellations, and retries.
          </p>
          <p>
            You can also connect with a private iCal address from one Google Calendar. That address can grant access to the calendar feed, so keep it private. A Google Workspace administrator may disable private calendar addresses.
          </p>
          <p>
            Tuts reads calendar information only. It does not create, edit, or delete events in Google Calendar.
          </p>
        </section>

        <section>
          <h2>How Tuts uses and stores this data</h2>
          <p>
            Tuts uses calendar data to synchronize sessions into the connected business workspace. OAuth access and refresh tokens are encrypted when stored. A private iCal address is also encrypted when stored. Tuts retains normalized session information and limited sync data needed to keep sessions current and process cancellations.
          </p>
          <p>
            Importing attendee contact details into the Tuts CRM is optional and off by default. If you turn it on, attendee details such as names and email addresses may be added to that business&apos;s CRM. Without that option, attendee details may still appear on the related session in the workspace.
          </p>
          <p>
            Tuts uses Google data to provide the calendar features described here. It does not sell Google Calendar data, use it for advertising, or use it to train generalized AI or machine-learning models. Tuts&apos;s access and use of Google user data follows the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
              Google API Services User Data Policy, including its Limited Use requirements
            </a>.
          </p>
        </section>

        <section id="google-data-sharing" aria-labelledby="google-data-sharing-heading">
          <h2 id="google-data-sharing-heading">Who receives Google user data</h2>
          <p>
            Tuts shares, transfers, or discloses Google user data only to provide the features described in this notice. The recipients and purposes are:
          </p>
          <ul>
            <li>
              <strong>Your connected tutoring business.</strong> Authorized workspace owners, administrators, and other staff with the required permissions can view synchronized sessions and attendee details. When staff link a session to a student, that student and their authorized parent can see their own session details in the student portal. They do not receive the business&apos;s other students&apos; sessions or your Google credentials.
            </li>
            <li>
              <strong>Cloudflare.</strong> Cloudflare processes Google user data on Tuts&apos;s behalf to host the application, run synchronization and private service communications, and operate background processing and infrastructure storage.
            </li>
            <li>
              <strong>Neon.</strong> Neon PostgreSQL processes and stores Tuts&apos;s workspace records, synchronized session information, sync snapshots, and encrypted connector credentials on Tuts&apos;s behalf.
            </li>
            <li>
              <strong>Google.</strong> Tuts sends authorization requests and tokens to Google&apos;s authorization service and Calendar API to obtain, refresh, and use the read-only access you approve.
            </li>
            <li>
              <strong>Delivery providers for features your business activates.</strong> If imported attendee details become CRM contacts and your business uses email or messaging features, the selected recipients&apos; contact details and message content are sent to Resend or your business&apos;s configured SMTP email provider, or to Meta for WhatsApp Business delivery. This can include portal invitations and staff-approved communications. Connecting Google Calendar alone does not send attendees messages.
            </li>
          </ul>
          <p>
            Authorized workspace users can also download supported student reports and choose to share them outside Tuts. These exports may contain information derived from synchronized sessions. OAuth tokens and private iCal addresses are not included in these reports.
          </p>
          <p>
            Tuts does not sell Google user data or transfer it to advertisers, data brokers, or information resellers. Tuts does not share, transfer, or disclose it for purposes other than providing the user-facing features described here, and does not use Google Workspace API data to develop, improve, or train generalized or non-personalized AI or machine-learning models.
          </p>
        </section>

        <section id="google-data-protection" aria-labelledby="google-data-protection-heading">
          <h2 id="google-data-protection-heading">How Tuts protects Google user data</h2>
          <p>
            Tuts uses the following mechanisms to protect the confidentiality of Google user data, including sensitive Calendar information and connector credentials:
          </p>
          <ul>
            <li>
              <strong>Encryption in transit.</strong> The public Tuts application and requests to Google&apos;s authorization and Calendar APIs use HTTPS. Production database connections are configured to use TLS.
            </li>
            <li>
              <strong>Encryption of stored credentials.</strong> Google OAuth access and refresh tokens and private iCal addresses are encrypted using AES-256-GCM before storage. Encryption authenticates the owning business&apos;s identifier so credentials cannot simply be copied into another workspace. Encryption keys are kept in server-side deployment secrets and are not provided to the browser. Synchronized session details and sync snapshots are stored as workspace records in the access-controlled database.
            </li>
            <li>
              <strong>Database storage encryption.</strong> Our database provider, Neon, encrypts stored data at rest using AES-256. This protects database storage containing synchronized session details and sync snapshots. See{" "}
              <a href="https://neon.com/docs/security/security-overview" target="_blank" rel="noreferrer">Neon&apos;s security information</a>.
            </li>
            <li>
              <strong>Access controls and workspace isolation.</strong> Tuts checks authenticated sessions, current business membership, roles, and permissions before granting access. Database row-level security restricts tenant records to their business workspace. Internal services verify signed, expiring authorization contexts. Managing a Google Calendar connection requires owner or administrator permissions.
            </li>
            <li>
              <strong>Restricted credential exposure and diagnostic logging.</strong> Connection responses and student reports exclude Google OAuth tokens and private iCal addresses. Application diagnostics are designed to redact credentials, message content, and sensitive URL parameters instead of recording raw provider responses.
            </li>
            <li>
              <strong>Read-only access and disconnection.</strong> Tuts requests only Calendar read permissions, reads events from the calendar you select, and lets you disconnect that source. Disconnecting stops synchronization and removes the stored connector credentials and private sync snapshots, as explained below.
            </li>
          </ul>
        </section>

        <section>
          <h2>Disconnecting and deletion requests</h2>
          <p>
            Disconnecting removes the stored Google credentials or private iCal address, stops future synchronization, deletes the connector&apos;s private sync snapshots, and removes that connection&apos;s synchronized session records from the Tuts session calendar. If you enabled attendee import, contacts already added to the business CRM are separate records and may remain after disconnect; a workspace administrator can remove those contacts or request deletion.
          </p>
          <p>
            You can revoke Tuts&apos;s Google access in your Google Account. For an iCal connection, reset the private calendar address in Google Calendar to invalidate the old address. To ask about deleting Tuts-held data, contact{" "}
            <a href="mailto:omar@palladiumscholars.com">omar@palladiumscholars.com</a> and identify the business workspace and connection. Do not email a private iCal address.
          </p>
        </section>

        <footer className={styles.footer}>
          <p>Questions about this notice or a data deletion request?</p>
          <a href="mailto:omar@palladiumscholars.com">omar@palladiumscholars.com</a>
          <a className={styles.back} href="/">Back to Tuts</a>
        </footer>
      </article>
    </main>
  );
}
