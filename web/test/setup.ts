import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Registers document/window/etc. globally for `bun test` so DOM-building code
// (renderRich) runs without a browser.
GlobalRegistrator.register();
