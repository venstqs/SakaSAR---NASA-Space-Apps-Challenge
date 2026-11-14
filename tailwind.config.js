/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        nasa: {
          blue: '#0B3D91',
          red: '#FC3D21',
          dark: '#030712',
          panel: '#0F172A',
          border: '#1E293B',
          glow: '#38BDF8'
        }
      },
      fontFamily: {
        mono: ['Courier New', 'Courier', 'monospace', 'ui-monospace'],
      }
    },
  },
  plugins: [],
}
