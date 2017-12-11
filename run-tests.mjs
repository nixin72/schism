// -*- javascript -*-
import * as Schism from './rt/rt';

import assert from 'assert';
import child_process from 'child_process';
import fs from 'fs';
import util from 'util';

const OPTIONS = {
    use_snapshot: true, // load schism-stage0.wasm if true instead of
                        // building with host scheme

    // which stages to build and run tests for
    stage0: true,
    stage1: false,
    stage2: false,
    stage3: false, // compile-only, no point running tests
}

// Returns the contents of out.wasm
async function compileWithHostScheme(name) {
    const { stdout, stderr } = await util.promisify(child_process.exec)(`./schism.ss ${name}`);

    //console.log(`stdout: ${stdout}`);
    //console.log(`stderr: ${stderr}`);

    return util.promisify(fs.readFile)('out.wasm');
}

// Uses host scheme to compile schism and returns the wasm bytes
async function compileBootstrap() {
    return compileWithHostScheme('./schism/compiler.ss');
}

async function runTest(name, compile = compileWithHostScheme) {
    const file = await compile(name);

    const engine = new Schism.Engine;
    const wasm = await engine.loadWasmModule(file);

    // set up the input port
    const input_file = name.replace(".ss", ".input");
    if (fs.existsSync(input_file)) {
	engine.setCurrentInputPort(fs.readFileSync(input_file));
    }

    let raw_result;
    let result;
    try {
	raw_result = wasm.exports['do-test']();
	result = engine.jsFromScheme(raw_result);
    } catch (e) {
	console.error(e.stack);
	throw e;
    }
    //console.info(raw_result);
    assert.ok(result != false, "test failed");
}

async function runTests() {
    let failures = [];
    const files = await util.promisify(fs.readdir)('test');
    for (const test of files) {
	if (test.endsWith(".ss")) {
	    let local_failures = [];
	    console.info(`Running test ${test}`);
	    async function run_stage(name, compile) {
		try {
		    await runTest(`test/${test}`, compile);
		    console.info(`  ${name} succeeded`);
		} catch (e) {
		    console.info(`  ${name} FAILED`);
		    console.info(e.stack);
		    local_failures.push([name]);
		}
	    }
	    if (OPTIONS.stage0) {
		await run_stage("stage0", stage0_compile);
	    }
	    if (OPTIONS.stage1) {
		await run_stage("stage1", stage1_compile);
	    }
	    if (OPTIONS.stage2) {
		await run_stage("stage2", stage2_compile);
	    }
	    if (local_failures.length > 0) {
		failures.push([test, local_failures]);
	    }
	}
    }
    return failures;
}

async function createSchismFromWasm(schism_bytes) {
    return async function(name) {
	let engine = new Schism.Engine;
	let schism = await engine.loadWasmModule(schism_bytes);
	engine.setCurrentInputPort(fs.readFileSync(name));
	engine.clearOutputBuffer();
	schism.exports['compile-stdin->stdout']();

	const compiled_bytes = new Uint8Array(engine.output_data);
	fs.writeFileSync('out.wasm', compiled_bytes);
	return compiled_bytes;
    };
}

function make_compiler(compiler_bytes) {
    return async function(bytes) {
	const engine = new Schism.Engine;
	const schism = await engine.loadWasmModule(await compiler_bytes);
	engine.setCurrentInputPort(bytes);
	schism.exports['compile-stdin->stdout']();
	return new Uint8Array(engine.output_data);
    }
}

// The stage0 bytes, either loaded from a snapshot
// (schism-stage0.wasm) or compiled by the host Scheme.
const stage0_bytes = OPTIONS.stage0 ? (async function() {
    return OPTIONS.use_snapshot
	? fs.readFileSync('schism-stage0.wasm')
	: await compileBootstrap()
})() : undefined;
// Compile bytes using the stage0 compiler.
const stage0_compile = OPTIONS.stage0 ? make_compiler(stage0_bytes) : undefined;
const stage1_bytes = OPTIONS.stage1 ? stage0_compile(fs.readFileSync('./schism/compiler.ss'))
                                    : undefined;
const stage1_compile = OPTIONS.stage1 ? make_compiler(stage1_bytes) : undefined;
const stage2_bytes = OPTIONS.stage2 ? stage1_compile(fs.readFileSync('./schism/compiler.ss'))
                                    : undefined;
const stage2_compile = OPTIONS.stage2 ? make_compiler(stage2_bytes) : undefined;
const stage3_bytes = OPTIONS.stage3 ? stage2_compile(fs.readFileSync('./schism/compiler.ss'))
                                    : undefined;

// We should be at a fixpoint by now, so we compile stage3 only to check for equality.
async function checkCompilerFixpoint() {
    assert.equal(await stage2_bytes, await stage3_bytes);
}

try {
    let results = runTests().catch((e) => { throw e });
    if (OPTIONS.stage3) {
	checkCompilerFixpoint().catch((e) => { throw e });
    }
    results.then((failures) => {
	if (failures.length > 0) {
	    console.info("Some tests failed:");
	    for(const failure of failures) {
		console.info(`    '${failure[0]}': ${failure[1].join(', ')}`);
	    }
	    throw new Error("Tests failed");
	}
    });
} catch (e) {
    console.error(e.stack);
    throw e;
}
