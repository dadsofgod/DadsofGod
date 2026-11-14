// There is no inline tailwind.config on the pages. The Play CDN was using
// Tailwind defaults, and the custom rules (.gold, .logo-glow, product hover)
// live in each page's <style> block. Rebuild with:
//   npx --yes tailwindcss@3.4.17 -i assets/tailwind.input.css -o assets/site.css --minify
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./*.html"],
  theme: {
    extend: {},
  },
  plugins: [],
};
