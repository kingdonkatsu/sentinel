"use client";

export default function SettingsPage() {
  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold text-white mb-2">Settings</h2>
      <p className="text-sm text-slate-400 mb-8">
        Configure your Sentinel dashboard connection and preferences.
      </p>

      <div className="space-y-6">
        {/* API Configuration */}
        <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700/50">
          <h3 className="text-sm font-semibold text-slate-300 mb-4">
            API Configuration
          </h3>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                API URL
              </label>
              <input
                type="text"
                defaultValue="http://localhost:8000"
                className="w-full px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-lg text-sm text-slate-300 focus:border-blue-500 focus:outline-none"
                readOnly
              />
              <p className="text-xs text-slate-500 mt-1">
                Configured via NEXT_PUBLIC_API_URL environment variable.
              </p>
            </div>
          </div>
        </div>

        {/* Privacy Information */}
        <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700/50">
          <h3 className="text-sm font-semibold text-slate-300 mb-4">
            Privacy & Compliance
          </h3>
          <div className="space-y-3 text-sm text-slate-400">
            <div className="flex items-start gap-3">
              <span className="text-green-400 mt-0.5">&#10003;</span>
              <p>
                <strong className="text-slate-300">Zero raw data storage.</strong>{" "}
                No images, text, or video content ever leaves the worker&apos;s
                device.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-green-400 mt-0.5">&#10003;</span>
              <p>
                <strong className="text-slate-300">24-hour TTL.</strong> All
                score records are automatically purged after 24 hours, matching
                the Instagram Stories lifecycle.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-green-400 mt-0.5">&#10003;</span>
              <p>
                <strong className="text-slate-300">Pseudonymous tokens.</strong>{" "}
                Account identifiers are SHA-256 hashed with a per-installation
                salt. They cannot be reverse-engineered.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-green-400 mt-0.5">&#10003;</span>
              <p>
                <strong className="text-slate-300">
                  GDPR Article 9 compliant.
                </strong>{" "}
                Architecture reviewed for sensitive personal data handling under
                EU regulations.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-green-400 mt-0.5">&#10003;</span>
              <p>
                <strong className="text-slate-300">
                  Instagram ToS compliant.
                </strong>{" "}
                No scraping, no API abuse. Extension only analyses what the
                worker is actively viewing.
              </p>
            </div>
          </div>
        </div>

        {/* About */}
        <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700/50">
          <h3 className="text-sm font-semibold text-slate-300 mb-2">About</h3>
          <p className="text-sm text-slate-400">
            Sentinel v0.1.0 — Privacy-first mental health triage for youth
            workers. This tool is a triage aid, not a diagnostic tool. It does
            not replace clinical assessment.
          </p>
        </div>
      </div>
    </div>
  );
}
