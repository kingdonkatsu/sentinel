"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoryDetector = void 0;
const image_analyser_1 = require("./image-analyser");
const text_analyser_1 = require("./text-analyser");
const RESERVED_PATHS = new Set([
    "",
    "activity",
    "accounts",
    "archive",
    "direct",
    "home",
    "inbox",
    "messages",
    "notifications",
    "explore",
    "p",
    "reel",
    "reels",
    "search",
    "stories",
]);
const SPONSORED_LABEL_PATTERNS = [
    /\bsponsored\b/i,
    /\bpaid partnership\b/i,
    /\bpromoted\b/i,
];
const SPONSORED_CTA_PATTERNS = [
    /\blearn more\b/i,
    /\bshop now\b/i,
    /\bview shop\b/i,
    /\bbook now\b/i,
    /\bget quote\b/i,
    /\bget tickets\b/i,
    /\binstall now\b/i,
    /\bdownload\b/i,
    /\border now\b/i,
    /\bsign up\b/i,
    /\bcontact us\b/i,
    /\bwatch more\b/i,
    /\bvisit (site|website)\b/i,
    /\bswipe up\b/i,
];
const HEADER_AD_LABEL_PATTERNS = [/^ad$/i, /^sponsored$/i];
class StoryDetector {
    observer;
    pollTimer = null;
    isProcessing = false;
    lastProcessedAt = 0;
    lastProcessedSignature = "";
    processedSignatures = new Map();
    cachedUsernames = new Map();
    pipeline;
    THROTTLE_MS = 1500;
    POLL_MS = 1500;
    DUPLICATE_WINDOW_MS = 10000;
    SIGNATURE_TTL_MS = 120000;
    constructor(pipeline) {
        this.pipeline = pipeline;
        this.observer = new MutationObserver(this.onMutation.bind(this));
    }
    start() {
        if (document.body) {
            this.observer.observe(document.body, {
                childList: true,
                subtree: true,
            });
        }
        this.pollTimer = window.setInterval(() => {
            void this.scanForStory("poll");
        }, this.POLL_MS);
        void this.scanForStory("startup");
        console.log("[Sentinel] Story detector started");
    }
    stop() {
        this.observer.disconnect();
        if (this.pollTimer !== null) {
            window.clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
    async analyseVisibleStory() {
        const viewer = this.findStoryViewer();
        if (!viewer) {
            return {
                ok: false,
                message: "No Story viewer detected. Open an Instagram Story first.",
            };
        }
        const signature = this.buildStorySignature(viewer);
        const username = this.extractUsername(viewer, signature);
        const sponsoredEvidence = this.getSponsoredEvidence(viewer);
        if (sponsoredEvidence) {
            this.markSignatureProcessed(signature);
            return {
                ok: false,
                message: `Sponsored stories are ignored (${sponsoredEvidence}).`,
            };
        }
        const result = await this.processCurrentFrame(viewer, "manual", true);
        if (!result) {
            return {
                ok: false,
                message: "Story analysis was skipped. Try changing stories and retrying.",
            };
        }
        return {
            ok: true,
            message: `Analysed @${result.score.username} (${result.score.composite}/100)`,
            result,
        };
    }
    getVisibleStoryViewer() {
        return this.findStoryViewer();
    }
    onMutation() {
        void this.scanForStory("mutation");
    }
    async scanForStory(reason) {
        if (this.isProcessing) {
            return;
        }
        const viewer = this.findStoryViewer();
        if (!viewer) {
            return;
        }
        await this.processCurrentFrame(viewer, reason, false);
    }
    findStoryViewer() {
        const isStoryRoute = this.isStoryRouteActive();
        if (isStoryRoute) {
            const routeViewer = this.findStoryRouteViewer();
            if (routeViewer) {
                return routeViewer;
            }
        }
        const candidates = new Set();
        const selectors = ["div[role='dialog']"];
        if (isStoryRoute) {
            selectors.push("main", "section", "article");
        }
        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach((el) => {
                if (el instanceof HTMLElement) {
                    candidates.add(el);
                }
            });
        }
        let bestCandidate = null;
        let bestScore = 0;
        for (const candidate of candidates) {
            const score = this.scoreCandidate(candidate);
            if (score > bestScore) {
                bestCandidate = candidate;
                bestScore = score;
            }
        }
        return bestScore >= (isStoryRoute ? 5 : 8) ? bestCandidate : null;
    }
    findStoryRouteViewer() {
        const mediaCandidates = Array.from(document.querySelectorAll("video, img[src]"))
            .filter((el) => {
            return el instanceof HTMLVideoElement || el instanceof HTMLImageElement;
        })
            .filter((el) => this.isVisibleMedia(el))
            .sort((a, b) => this.mediaArea(b) - this.mediaArea(a));
        for (const media of mediaCandidates) {
            const container = this.findContainerForMedia(media);
            if (container) {
                return container;
            }
        }
        return null;
    }
    findContainerForMedia(media) {
        let current = media.parentElement;
        while (current && current !== document.body) {
            const rect = current.getBoundingClientRect();
            if (rect.width > window.innerWidth * 0.45 &&
                rect.height > window.innerHeight * 0.45) {
                return current;
            }
            current = current.parentElement;
        }
        return media.parentElement ?? media;
    }
    scoreCandidate(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width < window.innerWidth * 0.35) {
            return 0;
        }
        if (rect.height < window.innerHeight * 0.35) {
            return 0;
        }
        const hasMedia = el.querySelector('img[draggable="false"], img[src], video') !== null;
        if (!hasMedia) {
            return 0;
        }
        const isDialog = el.matches("div[role='dialog']");
        const isStoryRoute = this.isStoryRouteActive();
        const hasProgressBar = el.querySelectorAll('div[style*="scaleX"]').length > 0 ||
            el.querySelectorAll('div[role="progressbar"]').length > 0;
        const hasNavigationButtons = el.querySelector('button[aria-label*="Next"], button[aria-label*="Previous"], button[aria-label*="Pause"], button[aria-label*="Close"]') !== null;
        const hasReplyComposer = el.querySelector('input[placeholder*="Reply"], textarea[placeholder*="Reply"], [data-testid="reply-composer"], [aria-label*="Reply"]') !== null;
        const hasUserHeader = this.findUsernameLink(el) !== null;
        const fillsViewport = rect.width > window.innerWidth * 0.5 &&
            rect.height > window.innerHeight * 0.5;
        const hasStoryChrome = hasProgressBar || hasNavigationButtons || hasReplyComposer;
        const hasStoryRouteStructure = isStoryRoute && fillsViewport && hasUserHeader;
        if (!hasStoryChrome && !(isStoryRoute && isDialog) && !hasStoryRouteStructure) {
            return 0;
        }
        let score = 0;
        score += 3; // has media
        if (fillsViewport) {
            score += 2;
        }
        if (isDialog) {
            score += 3;
        }
        if (isStoryRoute) {
            score += 2;
        }
        if (hasProgressBar) {
            score += 4;
        }
        if (hasUserHeader) {
            score += 1;
        }
        if (hasNavigationButtons) {
            score += 2;
        }
        if (hasReplyComposer) {
            score += 2;
        }
        return score;
    }
    async processCurrentFrame(viewer, reason, force) {
        const now = Date.now();
        if (!force && now - this.lastProcessedAt < this.THROTTLE_MS) {
            return null;
        }
        const signature = this.buildStorySignature(viewer);
        const username = this.extractUsername(viewer, signature);
        if (!force &&
            signature === this.lastProcessedSignature &&
            now - this.lastProcessedAt < this.DUPLICATE_WINDOW_MS) {
            return null;
        }
        if (!force && this.wasRecentlyProcessed(signature, now)) {
            return null;
        }
        if (!force && !this.hasRenderableStoryContent(viewer)) {
            return null;
        }
        const sponsoredEvidence = this.getSponsoredEvidence(viewer);
        if (sponsoredEvidence) {
            this.markSignatureProcessed(signature, now);
            console.log("[Sentinel] Sponsored story skipped", {
                username,
                reason,
                evidence: sponsoredEvidence,
            });
            return null;
        }
        this.isProcessing = true;
        try {
            const result = await this.pipeline.analyse(viewer, username);
            const completedAt = Date.now();
            this.lastProcessedAt = completedAt;
            this.lastProcessedSignature = signature;
            this.markSignatureProcessed(signature, completedAt);
            console.log("[Sentinel] Story analysed", {
                reason,
                username: result.score.username,
                composite: result.score.composite,
                text: result.score.textScore,
                image: result.score.imageScore,
                transmitted: result.transmitted,
                transmissionError: result.transmissionError,
            });
            return result;
        }
        catch (error) {
            const failedAt = Date.now();
            this.markSignatureProcessed(signature, failedAt);
            console.warn("[Sentinel] Analysis error:", error);
            return null;
        }
        finally {
            this.isProcessing = false;
        }
    }
    buildStorySignature(viewer) {
        const mediaSource = this.normalizeMediaSource(this.getPrimaryMediaSource(viewer));
        const routeKey = this.isStoryRouteActive() ? window.location.pathname : "";
        const textSignature = mediaSource === "no-media"
            ? (0, text_analyser_1.extractText)(viewer)
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 120)
            : "";
        return `${routeKey}|${mediaSource}|${textSignature || ""}`;
    }
    hasRenderableStoryContent(viewer) {
        return (0, image_analyser_1.findPrimaryStoryMedia)(viewer) !== null;
    }
    getPrimaryMediaSource(viewer) {
        const media = (0, image_analyser_1.findPrimaryStoryMedia)(viewer);
        if (media instanceof HTMLImageElement && (media.currentSrc || media.src)) {
            return media.currentSrc || media.src;
        }
        if (media instanceof HTMLVideoElement &&
            (media.currentSrc || media.src || media.poster)) {
            return media.currentSrc || media.src || media.poster;
        }
        return "no-media";
    }
    normalizeMediaSource(source) {
        if (!source || source === "no-media") {
            return "no-media";
        }
        try {
            const url = new URL(source, window.location.origin);
            return `${url.origin}${url.pathname}`;
        }
        catch {
            return source.split("?")[0]?.split("#")[0] || source;
        }
    }
    extractUsername(viewer, signature) {
        const link = this.findUsernameLink(viewer);
        if (link) {
            const username = this.parseUsernameFromHref(link.getAttribute("href"));
            if (username) {
                this.cachedUsernames.set(signature, username);
                return username;
            }
        }
        const textCandidates = viewer.querySelectorAll("header span, header a, span[dir='auto']");
        for (const candidate of textCandidates) {
            const text = candidate.textContent?.trim();
            if (text &&
                /^[A-Za-z0-9._]{1,30}$/.test(text) &&
                !RESERVED_PATHS.has(text.toLowerCase())) {
                this.cachedUsernames.set(signature, text);
                return text;
            }
        }
        const routeUsername = this.parseUsernameFromStoryRoute();
        if (routeUsername) {
            this.cachedUsernames.set(signature, routeUsername);
            return routeUsername;
        }
        return this.cachedUsernames.get(signature) ?? "unknown_story";
    }
    wasRecentlyProcessed(signature, now) {
        this.pruneProcessedSignatures(now);
        const processedAt = this.processedSignatures.get(signature);
        return processedAt !== undefined && now - processedAt < this.SIGNATURE_TTL_MS;
    }
    markSignatureProcessed(signature, now = Date.now()) {
        this.lastProcessedAt = now;
        this.lastProcessedSignature = signature;
        this.processedSignatures.set(signature, now);
    }
    pruneProcessedSignatures(now) {
        for (const [signature, processedAt] of this.processedSignatures) {
            if (now - processedAt >= this.SIGNATURE_TTL_MS) {
                this.processedSignatures.delete(signature);
                this.cachedUsernames.delete(signature);
            }
        }
    }
    isStoryRouteActive() {
        const segments = window.location.pathname.split("/").filter(Boolean);
        return segments[0]?.toLowerCase() === "stories";
    }
    parseUsernameFromStoryRoute() {
        const segments = window.location.pathname.split("/").filter(Boolean);
        if (segments[0]?.toLowerCase() !== "stories") {
            return null;
        }
        if (segments[1]?.toLowerCase() === "highlights") {
            return null;
        }
        return this.parseUsernameFromHref(`/${segments[1] ?? ""}/`);
    }
    getSponsoredEvidence(viewer) {
        for (const root of this.getSponsoredScanRoots(viewer)) {
            const headerEvidence = this.findHeaderAdLabel(root);
            if (headerEvidence) {
                return headerEvidence;
            }
            const textEvidence = this.findSponsoredText(root);
            if (textEvidence) {
                return textEvidence;
            }
            const ctaEvidence = this.findSponsoredCta(root);
            if (ctaEvidence) {
                return ctaEvidence;
            }
        }
        return null;
    }
    findHeaderAdLabel(root) {
        const selector = "header span, header div, header a";
        for (const el of root.querySelectorAll(selector)) {
            if (!(el instanceof HTMLElement)) {
                continue;
            }
            const text = el.textContent?.trim();
            if (text &&
                HEADER_AD_LABEL_PATTERNS.some((pattern) => pattern.test(text))) {
                return text;
            }
        }
        return null;
    }
    getSponsoredScanRoots(viewer) {
        const roots = [];
        const seen = new Set();
        const addRoot = (root) => {
            if (!root || seen.has(root)) {
                return;
            }
            seen.add(root);
            roots.push(root);
        };
        addRoot(viewer);
        let current = viewer.parentElement;
        let depth = 0;
        while (current && current !== document.body && depth < 6) {
            addRoot(current);
            current = current.parentElement;
            depth += 1;
        }
        if (this.isStoryRouteActive()) {
            addRoot(document.querySelector("main"));
            addRoot(document.body);
        }
        return roots;
    }
    findSponsoredText(root) {
        const selector = "span, div, a, button, [aria-label], [role='button'], [data-testid]";
        for (const el of root.querySelectorAll(selector)) {
            if (!(el instanceof HTMLElement)) {
                continue;
            }
            const candidates = [
                el.textContent?.trim(),
                el.getAttribute("aria-label")?.trim(),
            ].filter((value) => Boolean(value));
            for (const candidate of candidates) {
                if (SPONSORED_LABEL_PATTERNS.some((pattern) => pattern.test(candidate))) {
                    return candidate;
                }
            }
        }
        return null;
    }
    findSponsoredCta(root) {
        const selector = "a, button, [role='button']";
        for (const el of root.querySelectorAll(selector)) {
            if (!(el instanceof HTMLElement)) {
                continue;
            }
            const candidates = [
                el.textContent?.trim(),
                el.getAttribute("aria-label")?.trim(),
            ].filter((value) => Boolean(value));
            for (const candidate of candidates) {
                if (SPONSORED_CTA_PATTERNS.some((pattern) => pattern.test(candidate))) {
                    return candidate;
                }
            }
        }
        return null;
    }
    isVisibleMedia(media) {
        const rect = media.getBoundingClientRect();
        if (rect.width < window.innerWidth * 0.25) {
            return false;
        }
        if (rect.height < window.innerHeight * 0.25) {
            return false;
        }
        if (media instanceof HTMLImageElement) {
            return media.complete && media.naturalWidth > 0;
        }
        return media.readyState >= 2;
    }
    mediaArea(media) {
        const rect = media.getBoundingClientRect();
        return rect.width * rect.height;
    }
    findUsernameLink(viewer) {
        const links = viewer.querySelectorAll("a[href]");
        for (const link of links) {
            if (!(link instanceof HTMLAnchorElement)) {
                continue;
            }
            if (this.parseUsernameFromHref(link.getAttribute("href"))) {
                return link;
            }
        }
        return null;
    }
    parseUsernameFromHref(href) {
        if (!href) {
            return null;
        }
        try {
            const url = new URL(href, window.location.origin);
            if (url.origin !== window.location.origin) {
                return null;
            }
            const segments = url.pathname.split("/").filter(Boolean);
            if (segments.length !== 1) {
                return null;
            }
            const candidate = segments[0];
            if (RESERVED_PATHS.has(candidate.toLowerCase())) {
                return null;
            }
            if (!/^[A-Za-z0-9._]{1,30}$/.test(candidate)) {
                return null;
            }
            return candidate;
        }
        catch {
            return null;
        }
    }
}
exports.StoryDetector = StoryDetector;
