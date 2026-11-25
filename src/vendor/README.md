# Vendored code

`jpeg-js-decoder.cjs` is `lib/decoder.js` from [jpeg-js](https://github.com/eugeneware/jpeg-js) 0.4.4, copied unchanged
(sha256 `a3f175fd6f62d142aad94d3bd90f3a30be4e076baf9b6a6fa31c8e84d9d4aa9f`). The decoder itself derives from
pdf.js and keeps its Apache 2.0 header; the package is BSD-3-Clause (`jpeg-js-LICENSE`).

It is vendored rather than installed because the GitHub Action runs straight from a checkout of this repository
with no `npm install`. It has no dependencies of its own. To update it, copy the file from a newer release and
run `npm test`.
