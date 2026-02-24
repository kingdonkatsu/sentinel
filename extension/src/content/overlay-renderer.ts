import type { RiskScore } from "../shared/types";

export class OverlayRenderer {
  private shadowHost: HTMLElement | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;

  show(score: RiskScore): void {
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
        .sentinel-label {
          opacity: 0.7;
        }
        @keyframes slideIn {
          from { transform: translateX(120%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
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
          (<span class="sentinel-label">Text:</span> ${score.textScore} |
          <span class="sentinel-label">Image:</span> ${score.imageScore})
        </div>
      </div>
    `;

    document.body.appendChild(this.shadowHost);

    // Auto-dismiss after 8 seconds
    this.dismissTimer = setTimeout(() => this.dismiss(), 8000);
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
