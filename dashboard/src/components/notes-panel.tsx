"use client";

import { useState, useEffect } from "react";

interface NotesPanelProps {
  token: string;
}

export function NotesPanel({ token }: NotesPanelProps) {
  const storageKey = `sentinel_notes_${token.slice(0, 16)}`;
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored) setNotes(stored);
  }, [storageKey]);

  function handleSave() {
    localStorage.setItem(storageKey, notes);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="bg-slate-800/50 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-300">
          Case Notes
          <span className="text-xs font-normal text-slate-500 ml-2">
            (stored locally only)
          </span>
        </h3>
        {saved && (
          <span className="text-xs text-green-400 animate-pulse">Saved</span>
        )}
      </div>

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Add your case notes here. These are stored locally on your device and never sent to the server..."
        className="w-full h-32 bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-sm text-slate-300 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none resize-none"
      />

      <button
        onClick={handleSave}
        className="mt-2 px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-medium rounded-lg transition-colors"
      >
        Save Notes
      </button>
    </div>
  );
}
