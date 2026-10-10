import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Excalidraw's class-based App logs "setState on unmounted component" under
  // strict-mode double mounting; it is harmless but noisy, so strict mode is off.
  reactStrictMode: false,
  // The floating Next.js devtools badge sits over the whiteboard; hide it.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        // Only run Tailwind on our own CSS. Without this it also rewrote
        // node_modules stylesheets (Excalidraw's) and stripped them.
        condition: { not: "foreign" },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
