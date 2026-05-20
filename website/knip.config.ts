export default {
  entry: ['src/pages/**/*.astro', 'scripts/*.mjs'],
  project: ['src/**/*.{astro,ts,mjs}', 'scripts/**/*.mjs'],
  ignoreDependencies: ['tailwindcss'],
}
