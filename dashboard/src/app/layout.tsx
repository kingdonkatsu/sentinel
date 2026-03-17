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
      <body className="bg-background-light selection:bg-primary/20 text-black min-h-screen">
        <Providers>
          <div className="flex min-h-screen">
            {/* Sidebar */}
            <nav className="w-64 bg-white border-r border-border-light p-12 flex flex-col fixed h-screen overflow-y-auto">
              <div className="mb-12">
                <h2 className="logo-text text-2xl font-bold text-black">Sentinel</h2>
                <p className="text-slate-600 text-xs mt-1">Active monitoring</p>
              </div>

              <div className="space-y-6 flex-1">
                <div>
                  <h3 className="logo-text font-bold text-sm text-black mb-4 uppercase tracking-wider opacity-50">Navigation</h3>
                  <div className="space-y-2">
                    <a
                      href="/dashboard"
                      className="flex items-center gap-3 px-4 py-2 rounded-lg bg-primary/5 text-primary text-sm font-bold transition-all orange-glow"
                    >
                      Overview
                    </a>
                    <a
                      href="/dashboard"
                      className="flex items-center gap-3 px-4 py-2 rounded-lg hover:bg-slate-50 text-slate-600 text-sm font-medium transition-all"
                    >
                      Priority Queue
                    </a>
                  </div>
                </div>

                <div>
                  <h3 className="logo-text font-bold text-sm text-black mb-4 uppercase tracking-wider opacity-50">System</h3>
                  <div className="space-y-2">
                    <a
                      href="/settings"
                      className="flex items-center gap-3 px-4 py-2 rounded-lg hover:bg-slate-50 text-slate-600 text-sm font-medium transition-all"
                    >
                      Settings
                    </a>
                  </div>
                </div>
              </div>

              <div className="mt-auto pt-8 border-t border-border-light opacity-60">
                <p className="text-[10px] text-slate-600 leading-relaxed font-medium">
                  REV: 2.4.0-STABLE
                </p>
              </div>
            </nav>

            {/* Main content */}
            <main className="flex-1 pl-64 pb-32">
              <div className="p-12">
                {children}
              </div>
            </main>
          </div>

          {/* Bottom Nav */}
          <nav className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-md border-t border-border-light px-12 py-4 z-50 flex items-center justify-between">
            <div className="flex items-center gap-8">
              <div className="flex items-center gap-2">
                <span className="logo-text font-bold text-slate-900">Sentinel</span>
              </div>
              <div className="h-4 w-[1px] bg-border-light"></div>
              <div className="flex gap-6">
                <a className="text-[11px] uppercase tracking-widest font-bold text-primary" href="/dashboard">Overview</a>
                <a className="text-[11px] uppercase tracking-widest font-bold text-slate-600" href="/dashboard">Priority Queue</a>
                <a className="text-[11px] uppercase tracking-widest font-bold text-slate-600" href="/settings">Settings</a>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right mr-4 border-r border-border-light pr-4">
                <p className="text-[10px] font-semibold text-slate-900">Admin Session</p>
                <p className="text-[10px] text-slate-600">ID: 0x42AF</p>
              </div>
              <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center border border-border-light">
                <span className="text-[10px] font-bold text-slate-400">JS</span>
              </div>
            </div>
          </nav>
        </Providers>
      </body>
    </html>
  );
}
