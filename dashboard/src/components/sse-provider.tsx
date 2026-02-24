"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { getScoreFeedUrl } from "@/lib/api";

interface ScoreEvent {
  username: string;
  composite: string;
  text: string;
  image: string;
  timestamp: string;
}

interface SSEContextValue {
  events: ScoreEvent[];
  connected: boolean;
}

const SSEContext = createContext<SSEContextValue>({
  events: [],
  connected: false,
});

export function SSEProvider({ children }: { children: React.ReactNode }) {
  const [events, setEvents] = useState<ScoreEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource(getScoreFeedUrl());
    sourceRef.current = source;

    source.onopen = () => setConnected(true);

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ScoreEvent;
        setEvents((prev) => [data, ...prev].slice(0, 100));
      } catch {
        // Ignore malformed events
      }
    };

    source.onerror = () => {
      setConnected(false);
    };

    return () => {
      source.close();
      setConnected(false);
    };
  }, []);

  return (
    <SSEContext.Provider value={{ events, connected }}>
      {children}
    </SSEContext.Provider>
  );
}

export function useScoreEvents() {
  return useContext(SSEContext);
}
