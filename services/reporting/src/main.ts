import { fileURLToPath } from "node:url";
import { bootstrap } from "@palladium/service-kit";
import { appOptions } from "./app.js";
await bootstrap({
    ...appOptions,
    migrationsDir: fileURLToPath(new URL("../migrations/", import.meta.url)),
});
