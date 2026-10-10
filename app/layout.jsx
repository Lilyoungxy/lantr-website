import "./globals.css";

export const metadata = {
  title: "Ary's tiny homepage",
  description: "Ary's little corner",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
