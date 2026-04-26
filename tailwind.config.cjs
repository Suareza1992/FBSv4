/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        fbs: {
          dark:     '#030303',
          dim:      '#1C1C1E',
          charcoal: '#2C2C2E',
          gold:     '#FFDB89',
          steel:    '#92A9E1',
        }
      }
    }
  },
  plugins: [],
}
