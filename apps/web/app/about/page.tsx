import type { Metadata } from "next";
import styles from "../privacy/privacy.module.css";

export const metadata: Metadata = {
  title: "About Tuts · Tutoring workspace",
  description: "Tuts helps independent tutors manage students, homework, resources, and read-only Google Calendar session sync.",
};

export default function AboutPage() {
  return (
    <main className={styles.page}>
      <article className={styles.notice}>
        <header className={styles.header}>
          <a className={styles.wordmark} href="/" aria-label="Tuts home">tuts</a>
          <a href="/privacy">Privacy</a>
        </header>

        <h1>A workspace for independent tutors.</h1>
        <p className={styles.lead}>
          Tuts helps independent tutors and tutoring businesses manage student records, homework, and learning resources in one workspace.
        </p>

        <section>
          <h2>Google Calendar session sync</h2>
          <p>
            Tuts can read events from a Google Calendar you choose and show them in your Tuts business workspace as sessions. Calendar access is read-only: Tuts does not create, change, or remove events in Google Calendar.
          </p>
          <ol>
            <li>In your Tuts workspace, open <strong>Connectors</strong> and choose <strong>Connect Google Calendar</strong>.</li>
            <li>Sign in to your own Google account and review the requested read-only permissions.</li>
            <li>Choose one readable calendar to sync to the Tuts workspace you are managing.</li>
          </ol>
          <p>
            You connect with your own Google account. You do not need to create or provide a Google API key. Tuts syncs calendar data into the selected business workspace; if you opt in, attendee contact details can also go to that workspace&apos;s CRM. Tuts does not update your Google Calendar.
          </p>
          <p>
            Attendee contact import into Tuts CRM is a separate optional setting and is off by default. See the <a href="/privacy">Google Calendar privacy notice</a> for data access, storage, and deletion details.
          </p>
        </section>

        <footer className={styles.footer}>
          <p>Questions about Tuts or Google Calendar sync?</p>
          <a href="mailto:omar@palladiumscholars.com">omar@palladiumscholars.com</a>
          <a className={styles.back} href="/">Open Tuts</a>
        </footer>
      </article>
    </main>
  );
}
