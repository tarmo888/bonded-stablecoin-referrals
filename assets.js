/*jslint node: true */
'use strict';
const conf = require('ocore/conf');
const eventBus = require('ocore/event_bus');
const aa_addresses = require("ocore/aa_addresses.js");
const validationUtils = require('ocore/validation_utils');
const dag = require('aabot/dag.js');

const referrals = require('./referrals.js');

let primaryAssets = [];
let oswapAssets = [];
let oswapPools = {};
let t1Arbs = {};
let interestArbs = {};
let governanceAAs = {};


async function addCurveAA(aa) {
	referrals.watchAA(aa);
	const vars = await dag.readAAStateVars(aa, '');
	let voting_asset;
	if (vars.fund_aa) // v2
		voting_asset = await dag.readAAStateVar(vars.fund_aa, 'shares_asset');
	else // v1
		voting_asset = vars.asset1;
	governanceAAs[vars.governance_aa] = { asset: voting_asset };
	primaryAssets.push(vars.asset1, vars.asset2);
}

async function addDepositAA(aa) {
	const asset = await dag.readAAStateVar(aa, 'asset');
	primaryAssets.push(asset);
}

async function addStableAA(aa) {
	const asset = await dag.readAAStateVar(aa, 'asset');
	primaryAssets.push(asset);
}

async function addFundAA(aa) {
	referrals.watchAA(aa);
	const fund_shares_asset = await dag.readAAStateVar(aa, 'shares_asset');
	primaryAssets.push(fund_shares_asset);
}

async function addT1ArbAA(aa, definition) {
	const vars = await dag.readAAStateVars(aa, '');
	const shares_asset = vars.shares_asset;
	const curve_aa = definition[1].params.curve_aa;
	const curve_definition_rows = await aa_addresses.readAADefinitions([curve_aa]);
	const curve_definition = JSON.parse(curve_definition_rows[0].definition);
	const curve_base_aa = curve_definition[1].base_aa;
	if (!conf.curve_base_aas.includes(curve_base_aa))
		return console.log(`t1 arb ${aa} based on a curve that is based on a foreign base AA ${curve_base_aa}`);
	const curve_params = await dag.readAAParams(curve_aa);
	const asset1 = await dag.readAAStateVar(curve_aa, 'asset1');
	primaryAssets.push(shares_asset);
	t1Arbs[aa] = {
		shares_asset,
		reserve_asset: curve_params.reserve_asset || 'base',
		asset1,
	};
	governanceAAs[vars.governance_aa] = { asset: shares_asset };
}

async function addInterestArbAA(aa, definition) {
	console.error('--- addInterestArbAA', aa, definition[1])
	const shares_asset = await dag.readAAStateVar(aa, 'shares_asset');
	const deposit_aa = definition[1].params.deposit_aa;
	const deposit_params = await dag.readAAParams(deposit_aa);
	const curve_definition_rows = await aa_addresses.readAADefinitions([deposit_params.curve_aa]);
	const curve_definition = JSON.parse(curve_definition_rows[0].definition);
	const curve_base_aa = curve_definition[1].base_aa;
	if (!conf.curve_base_aas.includes(curve_base_aa))
		return console.log(`interest arb ${aa} based on a curve that is based on a foreign base AA ${curve_base_aa}`);
	const asset2 = await dag.readAAStateVar(deposit_params.curve_aa, 'asset2');
	primaryAssets.push(shares_asset);
	interestArbs[aa] = {
		shares_asset,
		interest_asset: asset2,
	};
}


async function addCurveAAs() {
	const rows = await dag.getAAsByBaseAAs(conf.curve_base_aas);
	const aas = rows.map(row => row.address);
	for (let aa of aas)
		await addCurveAA(aa);
}

async function addDepositAAs() {
	const rows = await dag.getAAsByBaseAAs([conf.deposit_base_aa]);
	const aas = rows.map(row => row.address);
	for (let aa of aas)
		await addDepositAA(aa);
}

async function addStableAAs() {
	const rows = await dag.getAAsByBaseAAs([conf.stable_base_aa]);
	const aas = rows.map(row => row.address);
	for (let aa of aas)
		await addStableAA(aa);
}

async function addFundAAs() {
	const rows = await dag.getAAsByBaseAAs([conf.fund_base_aa]);
	const aas = rows.map(row => row.address);
	for (let aa of aas)
		await addFundAA(aa);
}

async function addT1ArbAAs() {
	const rows = await dag.getAAsByBaseAAs(conf.t1_arb_base_aas);
	for (let row of rows)
		await addT1ArbAA(row.address, row.definition);
}

async function addInterestArbAAs() {
	const rows = await dag.getAAsByBaseAAs([conf.interest_arb_base_aa]);
	for (let row of rows)
		await addInterestArbAA(row.address, row.definition);
}

const isEligibleForOswap = asset => asset === 'base' || primaryAssets.includes(asset);

async function addOswapAAs() {
	const vars = await dag.readAAStateVars(conf.oswap_factory_aa, 'pools.');
	for (let var_name in vars) {
		const aa = var_name.substr('pools.'.length, 32);
		const asset0 = vars[`pools.${aa}.asset0`];
		const asset1 = vars[`pools.${aa}.asset1`];
		const asset = vars[`pools.${aa}.asset`];
		if (!isEligibleForOswap(asset0) || !isEligibleForOswap(asset1)) {
			console.log(`skipping oswap var ${var_name} as its asset is not a primary asset`);
			continue;
		}
		if (!validationUtils.isValidAddress(aa))
			throw Error(`bad AA ${aa}`);
		if (oswapPools[aa]) {
			console.log(`pool asset ${asset} on AA ${aa} already added`);
			continue;
		}
		console.log(`adding oswap pool asset ${asset} on AA ${aa}`);
		oswapAssets.push(asset);
		oswapPools[aa] = {
			asset0,
			asset1,
			asset,
		};
	}
}

async function start() {
	await addCurveAAs();
	await addDepositAAs();
	await addStableAAs();
	await addFundAAs();
	await addT1ArbAAs();
	await addInterestArbAAs();
	await addOswapAAs();
	
	eventBus.on('aa_definition_saved', async payload => {
		console.log(`new AA ${payload.address}`);
		const base_aa = payload.definition[1].base_aa;
		if (!base_aa)
			return console.log(`new non-parameterized AA ${payload.address}`);
		if (conf.curve_base_aas.includes(base_aa))
			await addCurveAA(payload.address);
		else if (base_aa === conf.deposit_base_aa)
			await addDepositAA(payload.address);
		else if (base_aa === conf.stable_base_aa)
			await addStableAA(payload.address);
		else if (base_aa === conf.fund_base_aa)
			await addFundAA(payload.address);
		else if (conf.t1_arb_base_aas.includes(base_aa))
			await addT1ArbAA(payload.address, payload.definition);
		else if (base_aa === conf.interest_arb_base_aa)
			await addInterestArbAA(payload.address, payload.definition);
		else
			return console.log(`new foreign AA ${payload.address}`);
	});
	eventBus.on('aa_response_from_aa-' + conf.oswap_factory_aa, addOswapAAs);
}


exports.start = start;
exports.primaryAssets = primaryAssets;
exports.oswapAssets = oswapAssets;
exports.oswapPools = oswapPools;
exports.t1Arbs = t1Arbs;
exports.interestArbs = interestArbs;
exports.governanceAAs = governanceAAs;
