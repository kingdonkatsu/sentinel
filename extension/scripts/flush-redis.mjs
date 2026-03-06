import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const backendEnvPath = path.resolve(process.cwd(), "../backend/.env");
const redisUrl = process.env.REDIS_URL || readRedisUrlFromEnv(backendEnvPath);

if (!redisUrl) {
  console.error("[Sentinel] Unable to determine REDIS_URL for Redis flush");
  process.exit(1);
}

await flushRedis(redisUrl);
console.log(`[Sentinel] Redis cleared (${redisUrl})`);

function readRedisUrlFromEnv(envPath) {
  try {
    const envText = fs.readFileSync(envPath, "utf8");
    const line = envText
      .split(/\r?\n/)
      .find((entry) => entry.trim().startsWith("REDIS_URL="));

    if (!line) return null;
    return line.slice("REDIS_URL=".length).trim();
  } catch {
    return null;
  }
}

async function flushRedis(rawRedisUrl) {
  const redis = new URL(rawRedisUrl);
  if (redis.protocol !== "redis:") {
    throw new Error(`Unsupported Redis protocol: ${redis.protocol}`);
  }

  const host = redis.hostname || "127.0.0.1";
  const port = Number(redis.port || "6379");
  const db = parseDbIndex(redis.pathname);
  const password = redis.password || "";
  const username = redis.username || "";

  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = "";
    const steps = [];

    if (password) {
      steps.push(username ? ["AUTH", username, password] : ["AUTH", password]);
    }
    if (db !== 0) {
      steps.push(["SELECT", String(db)]);
    }
    steps.push(["FLUSHDB"]);
    steps.push(["QUIT"]);

    let stepIndex = 0;

    socket.setEncoding("utf8");
    socket.setTimeout(5000);

    socket.on("connect", () => {
      socket.write(encodeCommand(steps[stepIndex]));
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const boundary = buffer.indexOf("\r\n");
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        if (!line) continue;
        if (line.startsWith("-")) {
          socket.destroy();
          reject(new Error(line.slice(1)));
          return;
        }
        if (!line.startsWith("+")) {
          socket.destroy();
          reject(new Error(`Unexpected Redis response: ${line}`));
          return;
        }

        stepIndex += 1;
        if (stepIndex >= steps.length) {
          socket.end();
          resolve(undefined);
          return;
        }

        socket.write(encodeCommand(steps[stepIndex]));
      }
    });

    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Timed out while flushing Redis"));
    });

    socket.on("error", reject);
    socket.on("end", () => {
      if (stepIndex < steps.length) {
        reject(new Error("Redis connection closed before flush completed"));
      }
    });
  });
}

function parseDbIndex(pathname) {
  const normalized = pathname.replace("/", "");
  if (!normalized) return 0;

  const db = Number.parseInt(normalized, 10);
  return Number.isFinite(db) ? db : 0;
}

function encodeCommand(parts) {
  const segments = [`*${parts.length}\r\n`];
  for (const part of parts) {
    segments.push(`$${Buffer.byteLength(part)}\r\n${part}\r\n`);
  }
  return segments.join("");
}
