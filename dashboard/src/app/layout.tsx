import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Sentinel Dashboard",
  description: "Privacy-first mental health triage for youth workers",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Providers>
          <div className="flex min-h-screen">
            {/* Sidebar */}
            <nav className="w-64 bg-slate-900 border-r border-slate-800 p-6 flex flex-col">
              <div className="flex items-center gap-3 mb-8">
                <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center font-bold text-lg">
                  S
                </div>
                <div>
                  <h1 className="font-bold text-lg">Sentinel</h1>
                  <p className="text-xs text-slate-400">Triage Dashboard</p>
                </div>
              </div>

              <div className="space-y-1">
                <a
                  href="/dashboard"
                  className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-800 text-sm font-medium transition-colors"
                >
                  <span className="w-5 text-center">&#9632;</span>
                  Priority Queue
                </a>
                <a
                  href="/settings"
                  className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-800 text-sm font-medium transition-colors text-slate-400"
                >
                  <span className="w-5 text-center">&#9881;</span>
                  Settings
                </a>
              </div>

              <div className="mt-auto pt-6 border-t border-slate-800">
                <div className="bg-slate-800/50 rounded-lg p-3">
                  <p className="text-xs text-slate-400 leading-relaxed">
                    <strong className="text-slate-300">Privacy:</strong> No raw
                    content is stored. All data auto-purges after 24 hours.
                  </p>
                </div>
              </div>
            </nav>

            {/* Main content */}
            <main className="flex-1 p-8 overflow-auto">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
