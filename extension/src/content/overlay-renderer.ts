import type { ModalityResult, RiskScore } from "../shared/types";

export class OverlayRenderer {
  private shadowHost: HTMLElement | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;

  show(score: RiskScore, modalityResults?: ModalityResult[]): void {
    this.dismiss();

    this.shadowHost = document.createElement("div");
    this.shadowHost.id = "sentinel-overlay-host";
    const shadow = this.shadowHost.attachShadow({ mode: "closed" });

    const severity = score.composite >= 85 ? "critical" : "high";
    const bgColor =
      severity === "critical"
        ? "linear-gradient(135deg, #dc2626, #b91c1c)"
        : "linear-gradient(135deg, #f97316, #ea580c)";

    shadow.innerHTML = `
      <style>
        :host {
          position: fixed;
          top: 16px;
          right: 16px;
          z-index: 999999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          pointer-events: none;
        }
        .sentinel-badge {
          background: ${bgColor};
          color: white;
          padding: 14px 20px;
          border-radius: 14px;
          box-shadow: 0 4px 24px rgba(0,0,0,0.35);
          animation: slideIn 0.3s ease-out;
          max-width: 300px;
          backdrop-filter: blur(8px);
        }
        .sentinel-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
        }
        .sentinel-icon {
          width: 20px;
          height: 20px;
          background: rgba(255,255,255,0.2);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: bold;
        }
        .sentinel-title {
          font-weight: 700;
          font-size: 13px;
          letter-spacing: 0.5px;
        }
        .sentinel-scores {
          font-size: 11px;
          opacity: 0.9;
          line-height: 1.5;
        }
        .sentinel-label { opacity: 0.7; }
        .sentinel-modalities {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(255,255,255,0.2);
        }
        .sentinel-chip {
          display: flex;
          align-items: center;
          gap: 3px;
          background: rgba(0,0,0,0.2);
          border-radius: 5px;
          padding: 2px 6px;
          font-size: 10px;
        }
        .sentinel-dot {
          width: 6px; height: 6px;
          border-radius: 50%;
        }
        .dot-crit { background: #fca5a5; }
        .dot-high { background: #fdba74; }
        .dot-med  { background: #fde68a; }
        .dot-low  { background: rgba(255,255,255,0.35); }
        @keyframes slideIn {
          from { transform: translateX(120%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      </style>
      <div class="sentinel-badge">
        <div class="sentinel-header">
          <div class="sentinel-icon">${severity === "critical" ? "!!" : "!"}</div>
          <div class="sentinel-title">${severity.toUpperCase()} RISK DETECTED</div>
        </div>
        <div class="sentinel-scores">
          <span class="sentinel-label">@${score.username}</span> &mdash;
          <span class="sentinel-label">Score:</span> ${score.composite}/100
        </div>
        ${this.renderModalityBreakdown(modalityResults)}
      </div>
    `;

    document.body.appendChild(this.shadowHost);
    this.dismissTimer = setTimeout(() => this.dismiss(), 8000);
  }

  private renderModalityBreakdown(results?: ModalityResult[]): string {
    if (!results || results.length === 0) return "";

    const active = results
      .filter((r) => r.available && r.score > 45)
      .sort((a, b) => b.score - a.score);

    if (active.length === 0) return "";

    const LABELS: Record<string, string> = {
      text: "Text", visual: "Visual", temporal: "Pattern",
      video: "Video", metadata: "Context",
    };

    const chips = active.map((r) => {
      const dot = r.score >= 85 ? "dot-crit"
                : r.score >= 70 ? "dot-high"
                : r.score >= 55 ? "dot-med"
                : "dot-low";
      return `<div class="sentinel-chip">
        <div class="sentinel-dot ${dot}"></div>
        <span>${LABELS[r.modality] ?? r.modality} ${r.score}</span>
      </div>`;
    }).join("");

    return `<div class="sentinel-modalities">${chips}</div>`;
  }

  dismiss(): void {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    if (this.shadowHost) {
      this.shadowHost.remove();
      this.shadowHost = null;
    }
  }
}
