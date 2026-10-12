import type { Metadata } from "next";
import GoogleCalendarCallbackForm from "./callback-form";

export const metadata: Metadata = {
  title: "Connect Google Calendar · Tuts",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function GoogleCalendarCallbackPage() {
  return <GoogleCalendarCallbackForm />;
}
