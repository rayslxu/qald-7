import * as fs from 'fs';
import { promises as pfs } from 'fs';
import assert from 'assert';
import * as ThingTalk from 'thingtalk';
import { ThingTalkUtils, EntityUtils, I18n } from 'genie-toolkit';

import SPARQLToThingTalkConverter from '../lib/converter';

async function main() {
    const manifest = await pfs.readFile('./manifest.tt', { encoding: 'utf8' });
    const library = ThingTalk.Syntax.parse(manifest, ThingTalk.Syntax.SyntaxType.Normal, { locale: undefined, timezone: undefined });
    assert(library instanceof ThingTalk.Ast.Library && library.classes.length === 1);
    const classDef = library.classes[0];
    const converter = new SPARQLToThingTalkConverter(classDef, { cache: 'wikidata_cache.sqlite', enablePropertyPath : true });
    const tokenizer = new I18n.LanguagePack('en').getTokenizer();
    const tests = fs.readFileSync('./test/tests.txt').toString('utf-8').split('====');

    const index = parseInt(process.argv[2]);
    const start = index ? (index > 0 ? index - 1 : tests.length + index) : 0;
    for (let i = Math.max(start, 0); i < tests.length; i++) {
        console.log(`Running test ${i + 1} ...` );
        const utterance = tests[i].slice(tests[i].indexOf('Utterance:') + 'Utterance:'.length, tests[i].indexOf('Keywords:')).trim();
        const keywords = tests[i].slice(tests[i].indexOf('Keywords:') + 'Keywords:'.length, tests[i].indexOf('SPARQL:')).trim();
        const sparql = tests[i].slice(tests[i].indexOf('SPARQL:') + 'SPARQL:'.length, tests[i].indexOf('TT:')).trim();
        const expected = tests[i].slice(tests[i].indexOf('TT:') + 'TT:'.length).trim();     
        const preprocessed = tokenizer.tokenize(utterance).tokens.join(' ');
        const converted = await converter.convert(sparql, utterance, keywords.split(', ').filter(Boolean));
        const thingtalk = ThingTalkUtils.serializePrediction(
            converted, 
            preprocessed,
            EntityUtils.makeDummyEntities(preprocessed),
            { locale: 'en', timezone: undefined, includeEntityValue :true }
        ).join(' ');

        assert.strictEqual(thingtalk, expected);
    }
}

main();