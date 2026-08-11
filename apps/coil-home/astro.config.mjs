import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://coil.curlycloud.dev",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
