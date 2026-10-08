import { existsSync } from "node:fs";

/** Load .env when present. CI passes real environment variables instead. */
if (existsSync(".env")) process.loadEnvFile(".env");
