import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        ink: "#05070C",
        panel: "#0B111D",
        line: "rgba(148, 163, 184, 0.16)",
        porcelain: "#E8E4DA",
        steel: "#9AA3B2",
        bus: "#334155",
        signal: "#F59E0B",
      },
    },
  },
  plugins: [],
};
export default config;
