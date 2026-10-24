import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { target: "es2022", sourcemap: true },
  // Agent worktrees live under .claude/worktrees and are full copies of this
  // repo, so the dev server was watching every one of them and force-reloading
  // the page whenever an agent touched a file in its own checkout.
  server: {
    host: true,
    watch: { ignored: ["**/.claude/worktrees/**"] },
    // The live-traffic feed (app/airtraffic.ts) is same-origin in production,
    // where flyby is served from chadsmith.dev/flyby/ beside /planes/. The dev
    // server is not, so it forwards.
    proxy: { "/planes": { target: "https://chadsmith.dev", changeOrigin: true } },
  },
});
