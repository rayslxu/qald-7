import assert from 'assert';
import { WikidataUtils } from '../lib';
import { GPT3Linker } from '../lib/ner/gpt3';

const TEST_CASES = [
    ["1", "show me museums named after louvre palace", ['Q1075988', 'Q207694'], []],
    ["2", "Which countries have more than two official languages?", [], []],
    ["3", "What is the highest mountain in Australia?", ["Q3960"], []],
    ["4", "Give me all cities in New Jersey with more than 10000 inhabitants.", ['Q1408'], []],
    ["5", "Which actors were born in Germany?", ['Q10800557', 'Q183'], []],
    ["6", "Does the Isar flow into a lake?", ['Q106588'], []],
    ["7", "Which writers studied in Istanbul?", ['Q406', 'Q36180'], []],
    ["8", "Which mountain is the highest after the Annapurna?", ['Q16466024'], []],
    ["9", "Are tree frogs a type of amphibian?", ['Q10908', 'Q53696'], []],
    ["10", "In which city did John F. Kennedy die?", ['Q9696'], []],
    ["11", "Is Lake Baikal bigger than the Great Bear Lake?", ['Q5525', 'Q5513'], []],
    ["12", "Was the Cuban Missile Crisis earlier than the Bay of Pigs Invasion?", ['Q191721', 'Q128160'], []],
];

async function main() {
    console.log("Checking GPT-3 Linker");
    const wikidata = new WikidataUtils('wikidata_cache.sqlite', 'bootleg.sqlite');
    const gptLinker = new GPT3Linker(wikidata, { ner_cache: 'gpt3-ned.sqlite' });
    let gptCorrect = 0;
    for (const [id, utterance, expectedEntities, expectedRelations] of TEST_CASES) {
        const result = await gptLinker.run(id as string, utterance as string);
        const entities = new Set(result.entities.map((e : any) => e.id));
        try {
            assert.deepStrictEqual(entities, new Set(expectedEntities));
            assert.deepStrictEqual(result.relations.map((r : any) => r.id), expectedRelations);
            console.log(`Test ${id} passed`);
            gptCorrect += 1;
        } catch(AssertionError) {
            console.log(`Test ${id} failed. Expected ${expectedEntities} and got ${new Array(...entities).join(', ')}. This means it found [ "${result.entities.map((e : any) => e.label).join('", "')}" ] in ${utterance}`);
        }
    }
    console.log(`GPT-3 gets ${(gptCorrect / TEST_CASES.length) * 100}% of test cases correct\n\n`);
}

main();
