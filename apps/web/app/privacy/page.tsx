import type { Metadata } from "next";
import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "Privacy notice · Tuts",
  description: "How Tuts accesses and uses Google Calendar data for calendar synchronization.",
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <article className={styles.notice}>
        <header className={styles.header}>
          <a className={styles.wordmark} href="/" aria-label="Tuts home">tuts</a>
          <p className={styles.updated}>Last updated: October 12, 2026</p>
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
            Calendar records are visible to authorized staff in the connected workspace. Tuts uses Cloudflare to run the application and Neon PostgreSQL to store workspace records; these infrastructure providers process data to operate the service. Synchronization communicates with Google&apos;s Calendar and authorization APIs.
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
