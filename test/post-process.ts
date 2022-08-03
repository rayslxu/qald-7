import assert from 'assert';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { PostProcessor } from '../lib/post-processor';
import { TP_DEVICE_NAME } from '../lib/utils/wikidata';

const TEST_CASES = [
    [
        'how many countries are there in europe ?',
        `count ( @${TP_DEVICE_NAME} . country ( ) filter contains ( continent , " Q46 " ^^${TP_DEVICE_NAME}:p_continent ) ) ;`,
        `count ( @${TP_DEVICE_NAME} . entity ( ) filter contains ( continent , " Q46 " ^^${TP_DEVICE_NAME}:entity ) && instance_of == " country " ^^${TP_DEVICE_NAME}:domain ) ;`
    ], 
    [
        'how many people live in the capital of Australia?',
        `[ population ] of @${TP_DEVICE_NAME} . entity ( ) filter in_array ( id , any ( [ capital ] of @${TP_DEVICE_NAME} . country ( ) filter id == " Q408 " ^^${TP_DEVICE_NAME}:country ) ) ;`,
        `[ population ] of @${TP_DEVICE_NAME} . entity ( ) filter in_array ( id , any ( [ capital ] of @${TP_DEVICE_NAME} . entity ( ) filter id == " Q408 " ^^${TP_DEVICE_NAME}:entity ) ) ;`
    ],
    [
        'Give me the birthdays of all actors of the television show Charmed',
        `[ < cast_member / date_of_birth > ] of @${TP_DEVICE_NAME} . television_series ( ) filter id == " Q162371 " ^^${TP_DEVICE_NAME}:television_series ;`,
        `[ < cast_member / date_of_birth > ] of @${TP_DEVICE_NAME} . entity ( ) filter id == " Q162371 " ^^${TP_DEVICE_NAME}:entity ;`
    ]
];

async function main() { 
    const tpClient = new Tp.FileClient({ thingpedia: './manifest.tt', locale: 'en' });
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
    const processor = new PostProcessor({ 
        tpClient, 
        schemas, 
        class: await schemas.getFullMeta(TP_DEVICE_NAME),
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