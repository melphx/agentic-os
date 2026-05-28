/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        space: {
          950: '#030712',
          900: '#0a0f1e',
          800: '#0f172a',
          700: '#1a2236',
          600: '#1e293b',
          500: '#334155',
        },
        neon: {
          indigo: '#6366f1',
          purple: '#a855f7',
          cyan:   '#06b6d4',
          emerald:'#10b981',
          rose:   '#f43f5e',
          amber:  '#f59e0b',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        'glow-sm':     '0 0 10px rgba(99,102,241,0.3)',
        'glow':        '0 0 20px rgba(99,102,241,0.4)',
        'glow-lg':     '0 0 40px rgba(99,102,241,0.5)',
        'glow-cyan':   '0 0 20px rgba(6,182,212,0.4)',
        'glow-purple': '0 0 20px rgba(168,85,247,0.4)',
        'glow-green':  '0 0 20px rgba(16,185,129,0.4)',
      },
      keyframes: {
        'float': {
          '0%,100%': { transform: 'translateY(0px)' },
          '50%':     { transform: 'translateY(-8px)' },
        },
        'pulse-glow': {
          '0%,100%': { boxShadow: '0 0 20px rgba(99,102,241,0.3)' },
          '50%':     { boxShadow: '0 0 50px rgba(99,102,241,0.7)' },
        },
      },
      animation: {
        'float':       'float 3s ease-in-out infinite',
        'spin-slow':   'spin 8s linear infinite',
        'spin-slower': 'spin 20s linear infinite',
        'pulse-glow':  'pulse-glow 3s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
