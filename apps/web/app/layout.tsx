import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Tuts · Your tutoring business",
  description: "An independent workspace for your tutoring business.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
