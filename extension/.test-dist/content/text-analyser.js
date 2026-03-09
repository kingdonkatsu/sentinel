"use strict";
/**
 * Lightweight text sentiment analysis using AFINN-165 word list.
 * Returns a risk score 0-100 (higher = more negative/distressed).
 *
 * For hackathon MVP: uses a built-in keyword approach for instant scoring.
 * Architecture supports swapping in Transformers.js DistilBERT later.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyseText = analyseText;
exports.extractText = extractText;
// High-signal distress keywords with weights (-5 to -1 scale)
const DISTRESS_KEYWORDS = {
    // Severe distress signals
    suicide: -5, kill: -5, die: -5, dead: -5, "end it": -5, overdose: -5,
    worthless: -4, hopeless: -4, "give up": -4, "no point": -4, cutting: -4,
    "self harm": -4, "self-harm": -4, "want to disappear": -4,
    // Moderate distress
    depressed: -3, anxiety: -3, crying: -3, lonely: -3, scared: -3,
    hate: -3, hurting: -3, numb: -3, broken: -3, trapped: -3,
    empty: -3, pain: -3, suffer: -3, nightmare: -3, panic: -3,
    // Mild distress
    sad: -2, tired: -2, stressed: -2, worried: -2, alone: -2,
    angry: -2, frustrated: -2, exhausted: -2, overwhelmed: -2, lost: -2,
    struggling: -2, "can't sleep": -2, insomnia: -2, "no one cares": -2,
    // Slight negative
    bad: -1, upset: -1, annoyed: -1, bored: -1, meh: -1,
    sigh: -1, ugh: -1, whatever: -1, "don't care": -1,
};
// Positive keywords that reduce risk score
const POSITIVE_KEYWORDS = {
    happy: 3, excited: 3, amazing: 3, grateful: 3, blessed: 3,
    love: 2, fun: 2, great: 2, awesome: 2, wonderful: 2,
    good: 1, nice: 1, okay: 1, fine: 1, cool: 1, chill: 1,
};
const UI_TEXT_PATTERNS = [
    /^sponsored$/i,
    /^paid partnership$/i,
    /^learn more$/i,
    /^shop now$/i,
    /^sign up$/i,
    /^download$/i,
    /^install now$/i,
    /^book now$/i,
    /^get quote$/i,
    /^order now$/i,
    /^watch more$/i,
    /^apply now$/i,
    /^contact us$/i,
    /^visit site$/i,
    /^see more$/i,
    /^reply$/i,
    /^send message$/i,
];
const DISTRESS_PATTERNS = compileKeywordPatterns(DISTRESS_KEYWORDS);
const POSITIVE_PATTERNS = compileKeywordPatterns(POSITIVE_KEYWORDS);
function analyseText(text) {
    if (!text || text.trim().length === 0) {
        return 50; // Neutral when no text present
    }
    const lower = text.toLowerCase();
    let totalScore = 0;
    let matchCount = 0;
    // Check distress keywords
    for (const { pattern, weight } of DISTRESS_PATTERNS) {
        if (pattern.test(lower)) {
            totalScore += weight;
            matchCount += 1;
        }
    }
    // Check positive keywords
    for (const { pattern, weight } of POSITIVE_PATTERNS) {
        if (pattern.test(lower)) {
            totalScore += weight;
            matchCount += 1;
        }
    }
    if (matchCount === 0) {
        return 50; // No signal = neutral
    }
    // Normalise: totalScore ranges roughly from -25 to +15
    // Map to 0-100 risk scale (negative score = higher risk)
    const normalised = 50 - totalScore * 3;
    return Math.max(0, Math.min(100, Math.round(normalised)));
}
/**
 * Extracts visible text from a Story viewer element.
 */
function extractText(viewer) {
    const textElements = viewer.querySelectorAll('span[dir="auto"], div[dir="auto"]');
    return Array.from(textElements)
        .filter((el) => isVisibleTextElement(el))
        .filter((el) => !el.closest("button, a[role='button'], [role='button']"))
        .map((el) => el.textContent?.trim() || "")
        .filter((text) => !UI_TEXT_PATTERNS.some((pattern) => pattern.test(text)))
        .filter((t) => t.length > 0)
        .join(" ");
}
function isVisibleTextElement(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
        return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity || "1") < 0.05) {
        return false;
    }
    const intersectionWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    const intersectionHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    return intersectionWidth > 8 && intersectionHeight > 8;
}
function compileKeywordPatterns(keywords) {
    return Object.entries(keywords).map(([keyword, weight]) => ({
        weight,
        pattern: createKeywordPattern(keyword),
    }));
}
function createKeywordPattern(keyword) {
    const escaped = escapeRegex(keyword.toLowerCase());
    return new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`);
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
