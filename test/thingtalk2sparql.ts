import * as fs from 'fs';
import assert from 'assert';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';

import { ThingTalkToSPARQLConverter } from '../lib/converter';
import { TP_DEVICE_NAME } from '../lib/utils/wikidata';

const entities = JSON.parse(fs.readFileSync('./domain.json', { encoding: 'utf8' })).data;

async function main() {
    const tpClient = new Tp.FileClient({ thingpedia: './manifest.tt', locale: 'en' });
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
    const classDef = await schemas.getFullMeta(TP_DEVICE_NAME);

    const options = {
        locale: 'en-US',
        timezone: undefined,
        cache: 'wikidata_cache.sqlite',
        bootleg: 'bootleg.sqlite',
        human_readable_instance_of: false
    };
    const converter = new ThingTalkToSPARQLConverter(classDef, entities, options);
    const tests = fs.readFileSync('./test/tests-reverse.txt').toString('utf-8').split('====');

    const index = parseInt(process.argv[2]);
    const start = index ? (index > 0 ? index - 1 : tests.length + index) : 0;
    for (let i = Math.max(start, 0); i < tests.length; i++) {
        console.log(`Running test ${i + 1} ...` );
        const utterance = tests[i].slice(tests[i].indexOf('Utterance:') + 'Utterance:'.length, tests[i].indexOf('TT:')).trim();
        const thingtalk = tests[i].slice(tests[i].indexOf('TT:') + 'TT:'.length, tests[i].indexOf('SPARQL:')).trim();
        const expected = tests[i].slice(tests[i].indexOf('SPARQL:') + 'SPARQL:'.length).trim();     
        const sparql = await converter.convert(utterance, thingtalk);
        assert.strictEqual(sparql, expected.replace(/\s+/g, ' '));
    }
    
}

main();
