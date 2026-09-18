import { PrismaClient } from "@prisma/client";

// Next.js dev mode hot-reloads route modules on every save, which would
// otherwise instantiate a fresh PrismaClient (and a fresh Postgres
// connection pool) each time -- caching it on `globalThis` survives reloads.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
