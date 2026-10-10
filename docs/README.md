# anarchon documentation

The documentation site, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build).

```sh
pnpm docs:dev       # from the repository root: http://localhost:4321, reloads on save
pnpm docs:build     # static site in docs/dist
pnpm docs:preview   # serve the built site
pnpm docs:check     # every diagram parses
```

## Layout

```
docs/
├── astro.config.mjs          site title, languages, sidebar
├── check-diagrams.mjs        parses every mermaid block
└── src/
    ├── content/
    │   ├── docs/             the pages (English, the root language)
    │   │   ├── index.mdx
    │   │   ├── getting-started/
    │   │   ├── guides/
    │   │   ├── backends/
    │   │   ├── internals/
    │   │   ├── recipes/
    │   │   └── reference/
    │   └── i18n/             translations of the site's own labels (search, "On this page"...)
    └── styles/custom.css
```

## Writing pages

- A page is a Markdown file with `title` and `description` in its front matter. Quote a value that contains a colon.
- Add a new page to the `sidebar` in `astro.config.mjs`, or it won't appear in the navigation.
- Link to other pages with **relative** links that end in a slash (`../job-options/`, `../../internals/leases/#fencing`), so the site also works under a sub-path.
- Diagrams are fenced code blocks with the language `mermaid`. They are drawn in the browser, so a syntax error doesn't fail the build: run `pnpm docs:check` after editing one.
- Notes use Starlight's asides: `:::note`, `:::tip`, `:::caution`.
- Code examples in the pages are not compiled. Keep them close to the files in `examples/`, which are.

## Adding a language

English is the root language: its pages are directly in `src/content/docs/` and have no URL prefix. Another language lives in a folder named after its code and is served under that prefix (`/el/guides/job-options/`).

1. Add it to `locales` in `astro.config.mjs`:

   ```js
   const locales = {
     root: { label: 'English', lang: 'en' },
     el: { label: 'Ελληνικά', lang: 'el' },
   };
   ```

2. Create `src/content/docs/el/` and copy pages into it **with the same file names**. Translate the content and the `title` and `description`. A page that isn't translated yet falls back to English, with a notice.
3. Translate the sidebar group labels: each group in `astro.config.mjs` has a `translations` object, e.g. `translations: { el: 'Οδηγοί' }`. Page labels come from each page's own title.
4. Starlight ships translations of its interface for many languages. To add or change one, create `src/content/i18n/el.json`.

Keep slugs (file names) in English in every language, so links and the language switcher keep working.

## Deploying

Set `site` in `astro.config.mjs`, and `base` when the site is not served from the root of its domain (for example `base: '/anarchon'` on GitHub Pages). Then publish `docs/dist`.
