// A string explicitly vouched for as static, trusted HTML. The brand is
// unforgeable from a plain string: the only way to obtain one is trustedHtml(),
// which is the single audited chokepoint. setHtml() is the ONLY innerHTML sink
// in the web client; every other DOM build goes through el()/createElement, so
// a user-controlled value can never become markup.

declare const safeHtmlBrand: unique symbol;
export type SafeHtml = string & { readonly [safeHtmlBrand]: true };

// Assert a string is static, trusted HTML (e.g. a bundled SVG icon). NEVER call
// this on runtime/user-derived data; that is the whole point of the brand.
export const trustedHtml = (html: string): SafeHtml => html as SafeHtml;

export function setHtml(target: Element, html: SafeHtml): void {
	// eslint-disable-next-line no-restricted-properties -- the sole sanctioned innerHTML sink
	target.innerHTML = html;
}
