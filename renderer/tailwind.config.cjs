const path = require('node:path');

module.exports = {
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src/**/*.{vue,js,ts,jsx,tsx}')
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter Variable",
          "-apple-system",
          "BlinkMacSystemFont",
          "Helvetica Neue",
          "sans-serif"
        ],
        mono: [
          "JetBrains Mono Variable",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "monospace"
        ]
      },
      keyframes: {
        "electric-pulse": {
          "0%, 100%": { opacity: "0.72", filter: "brightness(0.95)" },
          "50%": { opacity: "1", filter: "brightness(1.35)" }
        },
        "current-flow": {
          "to": { strokeDashoffset: "-44" }
        }
      },
      animation: {
        "electric-pulse": "electric-pulse 1.6s ease-in-out infinite",
        "current-flow": "current-flow 1.15s linear infinite"
      }
    }
  },
  plugins: []
};
