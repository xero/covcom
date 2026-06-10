// Test preload: sandbox all config I/O to a throwaway temp dir so the suite
// never reads or clobbers the developer's real ~/.config/covcom/config.json.
// config.ts resolves $XDG_CONFIG_HOME per call, so setting it here (before any
// test runs) redirects every readConfig/writeConfig to <tmp>/covcom/config.json.
// Individual tests may still override the file path (setConfigPath) for precise
// control.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
process.env.XDG_CONFIG_HOME ??= mkdtempSync(join(tmpdir(), 'covcom-test-config-'));
