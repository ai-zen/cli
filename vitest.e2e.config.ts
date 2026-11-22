import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

export default defineConfig({
  test: {
    isolate: false,
    include: ["src/__tests__/e2e.test.ts"],
  },
});
