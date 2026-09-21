import { reactRouter } from "@react-router/dev/vite";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import { defineConfig, loadEnv } from "vite";
import netlifyReactRouter from "@netlify/vite-plugin-react-router";
import netlify from "@netlify/vite-plugin";

export default defineConfig(({ mode }) => {
  // Load .env vars for compile-time `define` substitutions below.
  // The edge function runs in a separate Deno runtime spawned by
  // @netlify/vite-plugin; it does NOT inherit process.env from this config.
  // The only reliable way to get .env values into the edge function bundle
  // under `react-router dev` is Vite's `define`, which bakes string literals
  // at build time. `netlify dev` and production use Netlify.env.get() instead.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    resolve: {
      tsconfigPaths: true,
    },
    css: {
      postcss: {
        plugins: [tailwindcss, autoprefixer],
      },
    },
    plugins: [
      reactRouter(),
      netlify(),
      netlifyReactRouter({ edge: true }),
    ],
    define: {
      'process.env.DISCORD_BOT_TOKEN': JSON.stringify(env.DISCORD_BOT_TOKEN ?? ""),
      'process.env.DISCORD_CHANNEL_ID': JSON.stringify(env.DISCORD_CHANNEL_ID ?? ""),
    },
  };
});
