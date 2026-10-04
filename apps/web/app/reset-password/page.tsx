import type { Metadata } from "next";
import ResetPasswordForm from "./reset-password-form";

export const metadata: Metadata = {
  title: "Reset password · Tuts",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
