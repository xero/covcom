// Test preload: sandbox all config I/O to a throwaway temp dir so the suite
// never reads or clobbers the developer's real ~/.config/covcom/config.json.
// config.ts resolves COVCOM_CONFIG_DIR per call, so setting it here (before any
// test runs) redirects every readConfig/writeConfig in the suite. Individual
// tests may still override it with their own dir for precise control.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
process.env.COVCOM_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'covcom-test-config-'));
