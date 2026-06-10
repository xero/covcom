// CLI argument parser. A small getopt-style parser over process.argv, kept in
// its own module so it can be unit-tested without main.ts's startup side
// effects. Adding a flag is one entry in FLAGS below.
//
// Supported forms:
//   long:   --flag            --flag value      --flag=value
//   short:  -f                -f value          -fvalue          -f=value
//   bundled booleans:         -xa  ==  -x -a    (a value short ends the bundle)
//   bundled value at end:     -xac value        -xacvalue
// A space-form value that looks like another flag (starts with `-`) is treated
// as missing, so a flag is never swallowed as a value (e.g. `--join --clean`).
// Unknown flags are ignored.

export interface ParsedArgs {
	help:    boolean
	version: boolean
	clean:   boolean
	anon:    boolean
	config?: string
	join?:   string
}

type BoolKey  = 'help' | 'version' | 'clean' | 'anon';
type ValueKey = 'config' | 'join';

interface BoolSpec  { kind: 'bool';  key: BoolKey;  long: string; short: string }
interface ValueSpec { kind: 'value'; key: ValueKey; long: string; short: string }
type Spec = BoolSpec | ValueSpec;

const FLAGS: readonly Spec[] = [
	{ kind: 'bool', key: 'help', long: '--help', short: '-h' },
	{ kind: 'bool', key: 'version', long: '--version', short: '-v' },
	{ kind: 'bool', key: 'clean', long: '--clean', short: '-x' },
	{ kind: 'bool', key: 'anon', long: '--anon', short: '-a' },
	{ kind: 'value', key: 'config', long: '--config', short: '-c' },
	{ kind: 'value', key: 'join', long: '--join', short: '-j' },
];

const byLong  = new Map(FLAGS.map((f) => [f.long, f]));
const byShort = new Map(FLAGS.map((f) => [f.short[1], f]));

export function parseArgs(argv: string[]): ParsedArgs {
	const out: ParsedArgs = { help: false, version: false, clean: false, anon: false };
	const set = (spec: Spec, value: string | undefined): void => {
		if (spec.kind === 'bool') out[spec.key] = true;
		else if (value) out[spec.key] = value;
	};

	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];

		// long form: --flag, --flag=value, or --flag value
		if (tok.startsWith('--')) {
			const eq   = tok.indexOf('=');
			const name = eq >= 0 ? tok.slice(0, eq) : tok;
			const spec = byLong.get(name);
			if (!spec) continue;
			if (spec.kind === 'value') {
				if (eq >= 0) {
					set(spec, tok.slice(eq + 1));            // --flag=value (empty -> unset)
				} else {
					const next = argv[i + 1];
					if (next && !next.startsWith('-')) {
						set(spec, next);
						i++;
					}
				}
			} else {
				set(spec, undefined);
			}
			continue;
		}

		// short cluster: -v, -xa, -cvalue, -c=value, or a value short ending it
		if (tok.startsWith('-') && tok.length > 1) {
			let consumedNext = false;
			for (let j = 1; j < tok.length; j++) {
				const spec = byShort.get(tok[j]);
				if (!spec) break;                            // unknown short ends the cluster
				if (spec.kind === 'value') {
					const after = tok.slice(j + 1);          // rest of the token is the value
					if (after.length > 0) {
						set(spec, after.startsWith('=') ? after.slice(1) : after);
					} else {
						const next = argv[i + 1];
						if (next && !next.startsWith('-')) {
							set(spec, next);
							consumedNext = true;
						}
					}
					break;                                   // a value short consumes the rest
				}
				set(spec, undefined);
			}
			if (consumedNext) i++;
			continue;
		}

		// bare positional: none expected, ignored
	}
	return out;
}
