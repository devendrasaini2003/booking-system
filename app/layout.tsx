import "./globals.css";
export const metadata = { title: "Room booking" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
