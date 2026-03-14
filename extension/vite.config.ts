import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./public/manifest.json";

export default defineConfig({
  plugins: [crx({ manifest: manifest as any })],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        ocrHost: "src/content/dev/ocr-host.html",
        popup: "src/popup/popup.html",
      },
    },
  },
});
