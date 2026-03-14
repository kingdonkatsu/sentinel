import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./public/manifest.json";

const sentinelBuildStamp = `${process.env.npm_package_version ?? "dev"}-${new Date().toISOString()}`;

export default defineConfig({
  plugins: [crx({ manifest: manifest as any })],
  define: {
    __SENTINEL_BUILD_STAMP__: JSON.stringify(sentinelBuildStamp),
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        ocrSpikeOffscreen: "src/offscreen/ocr-spike.html",
        popup: "src/popup/popup.html",
      },
    },
  },
});
