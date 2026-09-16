/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        'clementi-crimson': '#ED1651',
        'clementi-orange': '#F47820',
        'clementi-pink': '#EF5A92',
        'clementi-lavender': '#A87FB7',
        'clementi-green': '#71BF45',
        'clementi-cyan': '#38BEDD',
        'clementi-charcoal': '#1A202C',
        'clementi-slate': '#4A5568',
        'clementi-border': '#E2E8F0',
        'clementi-subtle': '#F8F9FA',
        'clementi-white': '#FFFFFF',
        'action-primary': '#ED1651',
        'action-hover': '#D01244',
      },
      fontFamily: {
        display: ['"Century Gothic"', 'Montserrat', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        body: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      letterSpacing: {
        wordmark: '0.24em',
        'wordmark-tight': '0.22em',
        'wordmark-wide': '0.26em',
      },
      borderRadius: {
        sm: '6px',
        md: '12px',
        lg: '20px',
      },
      boxShadow: {
        subtle: '0 4px 12px rgba(237, 22, 81, 0.08)',
        elevated: '0 8px 24px rgba(0, 0, 0, 0.06)',
        card: '0 10px 30px -5px rgba(26, 32, 44, 0.08), 0 4px 12px -2px rgba(237, 22, 81, 0.04)',
      },
    },
  },
  plugins: [],
};
