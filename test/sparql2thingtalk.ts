import * as fs from 'fs';
import assert from 'assert';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { ThingTalkUtils, EntityUtils, I18n } from 'genie-toolkit';

import { SPARQLToThingTalkConverter } from '../lib/converter';
import { TP_DEVICE_NAME } from '../lib/utils/wikidata';

const testFiles = [
    './test/tests-qid-only.txt',
    './test/tests.txt'
];

async function main() {
    const tpClient = new Tp.FileClient({ thingpedia: './manifest.tt', locale: 'en' });
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
    const classDef = await schemas.getFullMeta(TP_DEVICE_NAME);
    for (const testFile of testFiles) {
        console.log('Running tests in', testFile);
        const excludeEntityDisplay = testFile.endsWith('qid-only.txt');
        const options = {
            cache: 'wikidata_cache.sqlite', 
            bootleg_db: 'bootleg.sqlite',
            human_readable_instance_of: false
        };
        const converter = new SPARQLToThingTalkConverter(classDef, options);
        const tokenizer = new I18n.LanguagePack('en').getTokenizer();
        const tests = fs.readFileSync(testFile).toString('utf-8').split('====');

        const index = parseInt(process.argv[2]);
        const start = index ? (index > 0 ? index - 1 : tests.length + index) : 0;
        for (let i = Math.max(start, 0); i < tests.length; i++) {
            console.log(`Running test ${i + 1} ...` );
            const utterance = tests[i].slice(tests[i].indexOf('Utterance:') + 'Utterance:'.length, tests[i].indexOf('SPARQL:')).trim();
            const sparql = tests[i].slice(tests[i].indexOf('SPARQL:') + 'SPARQL:'.length, tests[i].indexOf('TT:')).trim();
            const expected = tests[i].slice(tests[i].indexOf('TT:') + 'TT:'.length).trim();     
            const preprocessed = tokenizer.tokenize(utterance).tokens.join(' ');
            const converted = await converter.convert(sparql, preprocessed);
            converted.typecheck(schemas);
            const thingtalk = ThingTalkUtils.serializePrediction(
                converted, 
                preprocessed,
                EntityUtils.makeDummyEntities(preprocessed),
                { locale: 'en', timezone: 'utc', includeEntityValue: true, excludeEntityDisplay  }
            ).join(' ');

            assert.strictEqual(thingtalk, expected);
        }
    }
    
}

main();
