/**
 * Text modules.
 *
 * wrangler.toml declares a Text rule for `.csv` and `.html`, so importing one
 * yields its contents as a string. TypeScript needs telling separately; this
 * file is an ambient declaration, which is why it holds no imports.
 */
declare module '*.csv' {
  const content: string;
  export default content;
}

declare module '*.html' {
  const content: string;
  export default content;
}
