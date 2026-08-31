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
  },
});
