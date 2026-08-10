import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://t3x-home.businesses.workers.dev",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
