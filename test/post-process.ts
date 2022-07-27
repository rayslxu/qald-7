import assert from 'assert';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { PostProcessor } from '../lib/post-processor';

const TEST_CASES = [
    [
        'how many countries are there in europe ?',
        'count ( @org.wikidata . country ( ) filter contains ( continent , " Q46 " ^^org.wikidata:p_continent ) ) ;',
        'count ( @org.wikidata . entity ( ) filter instance_of == " Q6256 " ^^org.wikidata:entity && contains ( continent , " Q46 " ^^org.wikidata:entity ) ) ;'
    ], 
    [
        'how many people live in the capital of Australia?',
        `[ population ] of @org.wikidata . entity ( ) filter in_array ( id , any ( [ capital ] of @org.wikidata . country ( ) filter id == " Q408 " ^^org.wikidata:country ) ) ;`,
        `[ population ] of @org.wikidata . entity ( ) filter in_array ( id , any ( [ capital ] of @org.wikidata . entity ( ) filter id == " Q408 " ^^org.wikidata:entity ) ) ;`
    ],
    [
        'Give me the birthdays of all actors of the television show Charmed',
        `[ < cast_member / date_of_birth > ] of @org.wikidata . television_series ( ) filter id == " Q162371 " ^^org.wikidata:television_series ;`,
        `[ < cast_member / date_of_birth > ] of @org.wikidata . entity ( ) filter id == " Q162371 " ^^org.wikidata:entity ;`
    ]
];

async function main() { 
    const tpClient = new Tp.FileClient({ thingpedia: './manifest.tt', locale: 'en' });
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
    const processor = new PostProcessor({ 
        tpClient, 
        schemas, 
        class: await schemas.getFullMeta('org.wikidata'),
        normalizeDomains: 'always',
        normalizeEntityTypes: true,
        includeEntityValue: true, 
        excludeEntityDisplay: true 
    });
    for (const [utterance, before, after] of TEST_CASES) {
        const processed = await processor.postprocess(before, utterance);
        assert.strictEqual(processed.join(' '), after);
    }
}

main();