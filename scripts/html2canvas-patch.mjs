import { readFile } from 'node:fs/promises';

const buggyCall = 'createForeignObjectSVG(this.options.width * this.options.scale, this.options.height * this.options.scale, this.options.scale, this.options.scale, element)';
const fixedCall = 'createForeignObjectSVG(this.options.width * this.options.scale, this.options.height * this.options.scale, 0, 0, element)';

// html2canvas 1.4.1's foreign-object renderer adds an SVG origin even though the
// canvas is already scaled. At 1x/2x/3x it blanks the first 1/4/9 rows and columns.
// Patch the pinned ESM dependency while bundling; the color regression checks the
// first and last pixels so a missing or stale patch fails visibly.
export const html2canvasForeignObjectOriginPlugin = {
  name: 'html2canvas-foreign-object-origin',
  setup(builder) {
    let patched = false;
    builder.onLoad({ filter: /html2canvas[\\/]dist[\\/]html2canvas(?:\.esm)?\.js$/ }, async args => {
      const source = await readFile(args.path, 'utf8');
      const count = source.split(buggyCall).length - 1;
      if (count !== 1) throw new Error(`Expected one html2canvas 1.4.1 foreign-object origin, found ${count}.`);
      patched = true;
      return { contents: source.replace(buggyCall, fixedCall), loader: 'js' };
    });
    builder.onEnd(result => {
      if (!patched && !result.errors.length) return { errors: [{ text: 'html2canvas foreign-object origin patch was not applied.' }] };
    });
  },
};
