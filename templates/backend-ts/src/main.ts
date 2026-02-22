import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { healthRoutes } from "./routes/health.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

async function bootstrap() {
  const app = Fastify({ logger: true });

  await app.register(cors);
  await app.register(helmet);
  await app.register(healthRoutes);

  await app.listen({ port: PORT, host: HOST });
}

bootstrap();
