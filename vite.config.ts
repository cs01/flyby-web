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
    // The transit feeds (data/transitfeeds.ts) send no CORS headers; production
    // proxies them through deploy/nginx-flyby-feeds.conf and this does the same.
    proxy: {
      "/planes": { target: "https://chadsmith.dev", changeOrigin: true },
      "/flyby-feeds/mta": {
        target: "https://api-endpoint.mta.info",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/flyby-feeds\/mta\//, "/Dataservice/mtagtfsfeeds/nyct%2F"),
      },
      "/flyby-feeds/bart/tripupdate": {
        target: "https://api.bart.gov",
        changeOrigin: true,
        rewrite: () => "/gtfsrt/tripupdate.aspx",
      },
      "/flyby-feeds/nycferry": {
        target: "https://nycferry.connexionz.net",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/flyby-feeds\/nycferry\//, "/rtt/public/utility/gtfsrealtime.aspx/"),
      },
    },
  },
});
