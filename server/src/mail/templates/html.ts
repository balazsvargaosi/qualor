const TOKEN = Symbol('SafeHtml');

/**
 * Markup that may go into a message as it is. Only html`` (and raw() in layout.ts) make one: the
 * constructor refuses any other caller, so data can never pass for markup by accident.
 */
export class SafeHtml {
  readonly #markup: string;

  constructor(token: symbol, markup: string) {
    if (token !== TOKEN) throw new TypeError('SafeHtml is made by html`` only');
    this.#markup = markup;
  }

  toString(): string {
    return this.#markup;
  }
}

export type HtmlValue =
  SafeHtml | string | number | null | undefined | false | readonly HtmlValue[];

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

function render(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.toString();
  if (Array.isArray(value)) return (value as readonly HtmlValue[]).map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

/** E1 spec (M7): a template's markup; every interpolated string is escaped, SafeHtml passes through. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(TOKEN, out);
}

/** Fixed markup of layout.ts (never data). templates.test.ts fails when another template calls it. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(TOKEN, markup);
}
