/** @type {import('next').NextConfig} */
function resolveDevPort() {
  const portFlagIndex = process.argv.findIndex(
    (arg) => arg === "--port" || arg === "-p"
  );

  if (portFlagIndex !== -1) {
    return process.argv[portFlagIndex + 1] || "3000";
  }

  return process.env.PORT || "3000";
}

const isDev = process.env.NODE_ENV === "development";

const nextConfig = {
  output: "standalone",
  distDir: isDev ? `.next-dev-${resolveDevPort()}` : ".next",
};

module.exports = nextConfig;
