const test = require("node:test");
const assert = require("node:assert/strict");

const { StoryDetector } = require("../.test-dist/content/story-detector.js");

test("story detector does not treat highlights route as a username", () => {
  const restore = installStoryGlobals("/stories/highlights/17911706646162462/");

  try {
    const detector = new StoryDetector(makePipeline());
    assert.equal(detector.parseUsernameFromStoryRoute(), null);
  } finally {
    restore();
  }
});

test("story detector reuses the cached username for the same story signature", () => {
  const restore = installStoryGlobals("/stories/highlights/17911706646162462/");

  try {
    const detector = new StoryDetector(makePipeline());
    const signature = "/stories/highlights/17911706646162462/|https://cdn.instagram.com/story.jpg|";

    const viewerWithHeaderUsername = {
      querySelectorAll(selector) {
        if (selector === "a[href]") {
          return [];
        }

        if (selector === "header span, header a, span[dir='auto']") {
          return [{ textContent: "life" }];
        }

        return [];
      },
    };

    const viewerWithoutUsername = {
      querySelectorAll() {
        return [];
      },
    };

    assert.equal(detector.extractUsername(viewerWithHeaderUsername, signature), "life");
    assert.equal(detector.extractUsername(viewerWithoutUsername, signature), "life");
  } finally {
    restore();
  }
});

function makePipeline() {
  return {
    async analyse() {
      throw new Error("not used");
    },
  };
}

function installStoryGlobals(pathname) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousMutationObserver = global.MutationObserver;

  global.window = {
    location: {
      pathname,
      origin: "https://www.instagram.com",
    },
  };

  global.document = {
    body: null,
  };

  global.MutationObserver = class {
    constructor() {}

    observe() {}

    disconnect() {}
  };

  return () => {
    global.window = previousWindow;
    global.document = previousDocument;
    global.MutationObserver = previousMutationObserver;
  };
}
