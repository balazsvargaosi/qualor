// Node's file API is not in this project's type set; the unit tests run under Node.
declare const process: { cwd(): string; getBuiltinModule(id: string): unknown };
interface Fs {
  readdirSync(dir: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  readFileSync(file: string, enc: 'utf8'): string;
}
interface Path {
  join(...p: string[]): string;
  relative(a: string, b: string): string;
}

// A scrolling table wrapper must take focus and have a name, or a keyboard user cannot scroll it.
describe('scrollable table wrappers', () => {
  const fs = process.getBuiltinModule('node:fs') as Fs;
  const path = process.getBuiltinModule('node:path') as Path;
  const root = path.join(process.cwd(), 'src', 'app');
  const templates: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.html')) templates.push(file);
    }
  };
  walk(root);

  let mentions = 0;
  const wrappers: { file: string; tag: string; html: string }[] = [];
  for (const file of templates) {
    const html: string = fs.readFileSync(file, 'utf8');
    mentions += html.split('panel-scroll').length - 1;
    for (const m of html.matchAll(
      /<(?:div|section)\b[^>]*\bclass="[^"]*\bpanel-scroll\b[^"]*"[^>]*>/g,
    )) {
      wrappers.push({ file: path.relative(root, file), tag: m[0], html });
    }
  }

  it('matches every use of the class, in any form', () => {
    expect(wrappers.length).toBe(mentions);
  });

  it('finds the wrappers', () => {
    expect(wrappers.length).toBeGreaterThanOrEqual(32);
  });

  it.each(wrappers.map((w, i) => [`${w.file} #${i}`, w] as const))(
    '%s is focusable, a group and named',
    (_name, w) => {
      expect(w.tag).toContain('tabindex="0"');
      expect(w.tag).toContain('role="group"');
      const label = /aria-label="[^"]+"|\[attr\.aria-label\]="[^"]+"/.test(w.tag);
      const by = /(?<!\[attr\.)aria-labelledby="([^"]+)"/.exec(w.tag);
      const dynamic = /\[attr\.aria-labelledby\]="[^"]+"/.test(w.tag);
      expect(label || by !== null || dynamic).toBe(true);
      // A static reference must point at an element of the same template.
      if (by) expect(w.html).toMatch(new RegExp(String.raw`\sid="${by[1]}"`));
    },
  );
});
