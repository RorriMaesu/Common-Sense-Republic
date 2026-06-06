/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}'
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          navy: '#0B2545',
          sky: '#0E5C7B',
          teal: '#00C2A8',
          amber: '#FFB547',
          red: '#D92D20',
          gold: '#F59E0B',
        }
      },
      borderRadius: {
        'card': '12px'
      }
    },
  },
  plugins: [],
};
