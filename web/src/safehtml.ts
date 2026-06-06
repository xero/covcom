// A string explicitly vouched for as static, trusted HTML. The brand stops a
// plain string from reaching an innerHTML sink by accident; it is not a hard
// boundary (an explicit `x as unknown as SafeHtml` still forges one), so the
// real guarantee rests on trustedHtml() being the single audited chokepoint,
// enforced by lint/tests. setHtml() is the ONLY innerHTML sink in the web
// client; every other DOM build goes through el()/createElement + textContent,
// so a peer-controlled value can never become markup.

declare const safeHtmlBrand: unique symbol;
export type SafeHtml = string & { readonly [safeHtmlBrand]: true };

// Assert a string is static, trusted HTML (e.g. a bundled SVG icon). NEVER call
// this on runtime/user-derived data; that is the whole point of the brand.
export const trustedHtml = (html: string): SafeHtml => html as SafeHtml;

export function setHtml(target: Element, html: SafeHtml): void {
	// eslint-disable-next-line no-restricted-properties -- the sole sanctioned innerHTML sink
	target.innerHTML = html;
}
