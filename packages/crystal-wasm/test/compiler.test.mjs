// The package's tests: drive the compiler in Node, against the assets in
// assets/crystal/ (the ones the published package ships).
//
//   npm test --prefix packages/crystal-wasm
//
// `--experimental-wasm-exnref` is passed by the script: the optimized compiler
// emits the wasm-EH `exnref` value type, which current Chrome has on by default
// and older Node does not.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { createCompiler } from '../src/index.node.js';
import { resolveAssetSource, verifyReceipt } from '../src/assets.js';
import { ASSET_RECEIPTS } from '../src/asset-receipts.js';

const EXCEPTIONS = `begin
  raise "boom"
rescue ex : Exception
  puts "caught: #{ex.message}"
end
name = gets
puts "hello #{name}"
puts "done"
`;

const ARGUMENTS = `puts ARGV.join(",")
`;

const MULTI_FILE = `require "./helper"

puts helper_value
`;

// A compiler is expensive to make (the 35 MB module is compiled on creation) and
// reusable for any number of runs, so the tests share one.
describe('@live-codes/crystal-wasm', () => {
	let compiler;

	before(async () => {
		compiler = await createCompiler();
	});

	after(async () => {
		await compiler?.dispose();
	});

	test('reads the assets that ship in the package', async () => {
		assert.match(compiler.assetSource, /packaged with this library/);
		assert.ok(compiler.stats.stdlib > 1000, `stdlib files: ${compiler.stats.stdlib}`);
		assert.equal(compiler.stats.libs, Object.keys(ASSET_RECEIPTS).length - 3);
	});

	test('compiles, links and runs a program that raises, rescues and reads stdin', async () => {
		const result = await compiler.run(EXCEPTIONS, 'world\n');

		assert.equal(result.output, 'caught: boom\nhello world\ndone\n');
		assert.equal(result.exitCode, 0);
		assert.equal(result.ok, true);
		assert.deepEqual(result.errors, []);
		assert.equal(result.stdout, result.output);
		assert.ok(result.compileMs > 0);
		assert.ok(result.runMs >= 0);
	});

	test('gives the program its argv', async () => {
		const result = await compiler.run(ARGUMENTS, '', { args: ['--flag', 'value'] });

		assert.equal(result.stdout, '--flag,value\n');
		assert.equal(result.exitCode, 0);
	});

	test('compiles further sources the program requires', async () => {
		const result = await compiler.run(MULTI_FILE, '', {
			files: { 'helper.cr': 'def helper_value\n  42\nend\n' }
		});

		assert.equal(result.stdout, '42\n');
		assert.equal(result.exitCode, 0);
	});

	test('reports a compile error as diagnostics, not as a throw', async () => {
		const result = await compiler.run('puts "unterminated\n');

		assert.equal(result.ok, false);
		assert.equal(result.exitCode, null);
		assert.ok(result.errors.length > 0, 'expected diagnostics');
		assert.match(result.errors.join('\n'), /Unterminated string literal/);
		// Colour is stripped: a caller is showing these, not a terminal.
		assert.ok(!result.errors.join('').includes('\u001b['));
	});

	test('dispose() is final and idempotent', async () => {
		const disposable = await createCompiler();
		await disposable.dispose();
		await disposable.dispose();
		await assert.rejects(disposable.run('puts 1'), /disposed/);
	});
});

describe('the asset receipts', () => {
	test('reject a shorter file before hashing it', async () => {
		await assert.rejects(verifyReceipt('compiler.wasm.gz', new Uint8Array(4)), /is 4 bytes, expected/);
	});

	test('reject the right number of wrong bytes', async () => {
		const { bytes } = ASSET_RECEIPTS['stdlib.json.gz'];
		await assert.rejects(verifyReceipt('stdlib.json.gz', new Uint8Array(bytes)), /failed SHA-256/);
	});

	test('name an asset that was never pinned', async () => {
		await assert.rejects(verifyReceipt('nope.wasm', new Uint8Array(0)), /No pinned receipt/);
	});

	test('the receipts cover the whole payload', () => {
		const names = Object.keys(ASSET_RECEIPTS);
		assert.deepEqual(
			names.filter((name) => !name.startsWith('lib/')).sort(),
			['compiler.wasm.gz', 'lld.wasm.gz', 'stdlib.json.gz']
		);
		assert.equal(new Set(names).size, names.length);
	});
});

describe('without a filesystem', () => {
	test('createCompiler() asks for a baseUrl rather than guessing one', async () => {
		const { createCompiler: browserCreateCompiler } = await import('../src/index.js');
		await assert.rejects(
			browserCreateCompiler({}),
			/baseUrl is required here/
		);
	});

	test('resolveAssetSource accepts a relative URL only through the page', () => {
		assert.throws(() => resolveAssetSource({ baseUrl: 'file:///tmp/crystal/' }, null), /HTTP\(S\)/);
	});
});
