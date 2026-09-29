import { buildApplication } from "./app.js";
import { loadEnvironment } from "./config/env.js";

const environment = loadEnvironment();
const { app } = await buildApplication(environment);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down budget validation API");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: environment.HOST, port: environment.PORT });
} catch (error) {
  app.log.fatal({ err: error }, "Could not start budget validation API");
  process.exit(1);
}
