import fs from 'fs';
import path from 'path';

export interface Example {
    id : string,
    utterance : string,
    sparql : string
}

/**
 * Preprocess one QALD example to extract only useful information for us
 * @param example An example in QALD
 * @returns A cleaned example object with id, utterance, and sparql
 */
export function preprocessExample(example : any) : Example {
    return {
        id: example.id,
        utterance: example.question[0].string,
        sparql: example.query.sparql
    };
}

/**
 * Preprocess all QALD train/test examples into a cleaned array
 * @returns An array of examples
 */
export function preprocessQALD(experiment : string) : Example[] {
    const trainQuestions = JSON.parse(fs.readFileSync(path.join(__dirname, `../../../data/${experiment}/train.json`), 'utf-8'));
    const testQuestions = JSON.parse(fs.readFileSync(path.join(__dirname, `../../../data/${experiment}/test.json`), 'utf-8'));
    const questions = [];
    for (const example of trainQuestions.questions) 
        questions.push(preprocessExample(example));
    for (const example of testQuestions.questions) 
        questions.push(preprocessExample(example));
    return questions;
}


/**
 * In some examples of QALD-7, an entity span is splitted into multiple keywords,
 * manually override them to recover 
 */
export const ENTITY_SPAN_OVERRIDE : Record<string, string> = {
    "Q11631": "cosmonauts", // astronaut
    "Q15180": "cosmonauts", // soviet union
    "Q159": "cosmonauts", // russia
    "Q5274359": "the first season of the HBO television series The Sopranos".toLowerCase(),
    "Q4970706": "federal chancellors of germany",
    "Q10800557": "actors",
    "Q36": "polish",
    "Q53696": "tree frog",
    "Q10908" : "amphibian",
    "Q183" : "german",
    "Q4830453": "companies",
    "Q668": "indian",
    "Q16": "canadians",
    "Q33946": "czech"
};


export const MANUAL_CONVERSION : Record<string, string> = {
    // qald 7 test
    // id: 8
    "SELECT DISTINCT ?uri WHERE { ?uri <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q6256>  . ?cave <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q35509> . { ?cave <http://www.wikidata.org/prop/direct/P17> ?uri . }  UNION { ?cave <http://www.wikidata.org/prop/direct/P131>/<http://www.wikidata.org/prop/direct/P17> ?uri . } } GROUP BY ?uri HAVING (COUNT(DISTINCT ?cave) > 10)" : 
    "[ country ] of count ( @org.wikidata . cave ( ) ) by country filter count >= 10 ;",
    // id: 14
    "ASK WHERE { { SELECT ?largest WHERE { ?largest <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q515> . ?largest <http://www.wikidata.org/prop/direct/P17> <http://www.wikidata.org/entity/Q79> . ?largest <http://www.wikidata.org/prop/direct/P1082> ?population . } ORDER BY DESC(?population) LIMIT 1 } <http://www.wikidata.org/entity/Q79> <http://www.wikidata.org/prop/direct/P36> ?largest . }": 
    `[ contains ( capital_of , " Q79 " ^^org.wikidata:country ( " egypts " ) ) ] of sort ( population desc of @org.wikidata . city ( ) filter contains ( country , " Q79 " ^^org.wikidata:country ( " egypts " ) ) ) ;`,
    // id: 29
    "SELECT DISTINCT ?date WHERE { <http://www.wikidata.org/entity/Q211> <http://www.wikidata.org/prop/P463> ?membership . ?membership <http://www.wikidata.org/prop/statement/P463> <http://www.wikidata.org/entity/Q458> . ?membership <http://www.wikidata.org/prop/qualifier/P580> ?date . }" : 
    `[ start_time of ( member_of filter value == " Q458 " ^^org.wikidata:p_member_of ( " eu " ) ) ] of @org.wikidata . country ( ) filter id == " Q211 " ^^org.wikidata:country ( " latvia " ) ;`
};