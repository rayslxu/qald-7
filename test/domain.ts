import assert from 'assert';
import WikidataUtils from "../lib/utils/wikidata";
import BootlegUtils from '../lib/utils/bootleg';

const TEST_CASES = [
    ['Q6386177', 'lake'],
    ['Q2608065', 'film'],
    ['Q23572', 'television series'],
    ['Q213959', 'sports team'],
    ['Q128446', 'sports organization']
];

async function main() { 
    const wikidataUtils = new WikidataUtils('wikidata_cache.sqlite', 'bootleg.sqlite');
    const bootlegUtils = new BootlegUtils('bootleg.sqlite');
    for (const [entity, expectedDomain] of TEST_CASES) {
        const entityLabel = await wikidataUtils.getLabel(entity);
        const bootlegType = await bootlegUtils.getType(entity);
        const bootlegTypeLabel = await wikidataUtils.getLabel(bootlegType!);
        console.log(`Checking domain for ${entity} (${entityLabel}), with bootleg type ${bootlegTypeLabel} and expected type ${expectedDomain}`);
        const domain = await wikidataUtils.getDomain(entity);
        const domainLabel = await wikidataUtils.getLabel(domain!);
        assert.strictEqual(domainLabel, expectedDomain);
    }
}

main();