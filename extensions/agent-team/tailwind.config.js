/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./src/app/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--surface-root)', foreground: 'var(--text-primary)',
        card: 'var(--surface-card)', 'card-foreground': 'var(--text-primary)',
        popover: 'var(--surface-elevated)', 'popover-foreground': 'var(--text-primary)',
        primary: 'var(--accent)', 'primary-foreground': 'var(--accent-foreground)',
        secondary: 'var(--surface-hover)', 'secondary-foreground': 'var(--text-primary)',
        muted: 'var(--surface-muted)', 'muted-foreground': 'var(--text-secondary)',
        accent: 'var(--accent-dim)', 'accent-foreground': 'var(--text-primary)',
        destructive: 'var(--danger)', 'destructive-foreground': '#fff',
        border: 'var(--border)', input: 'var(--border-strong)', ring: 'var(--accent)'
      },
      borderRadius: { lg: 'var(--radius-lg)', md: 'var(--radius-md)', sm: 'var(--radius-sm)' },
      boxShadow: { sm: 'var(--shadow-sm)', md: 'var(--shadow-md)' },
      fontFamily: { sans: ['var(--font-body)'], mono: ['var(--font-mono)'] },
    },
  },
  plugins: [],
};
