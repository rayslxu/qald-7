import { WikidataUtils } from '../lib';
import { GPT3Rephraser } from '../lib/gpt3/rephraser';

const TEST_CASES : Array<[string, string[]]> = [
    ['where did the massive allied invasion of northern france take place in june 1944 ?', ['Q16471']],
    ['what is the world \' s tallest building in dubai called ?', ['Q613', 'Q41176']],
    ['what are eu countries ?', ['Q458']],
    ['what sport does rebecca adlington compete in ?', ['Q49287']],
    ['what religions are practiced in afghanistan ?', ['Q889']],
];

async function main() {
    const wikidata = new WikidataUtils('wikidata_cache.sqlite', 'bootleg.sqlite');
    const rephraser = new GPT3Rephraser('https://wikidata.openai.azure.com', wikidata);
    for (const [utterance, entities] of TEST_CASES) {
        const rephrase = await rephraser.rephrase(utterance, entities);
        console.log(rephrase);
    }
}

main();
