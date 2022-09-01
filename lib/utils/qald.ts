import fs from 'fs';
import path from 'path';
import { TP_DEVICE_NAME } from './wikidata';

export interface Example {
    id : number,
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
    "Q4830453": "company",
    "Q668": "indian",
    "Q16": "canadians",
    "Q33946": "czech"
};

export const MANUAL_SPARQL_REWRITE : Record<string, string> = {
    // qald 7 test
    // id: 42
    // part of -> season (item in wikidata changed)
    "SELECT DISTINCT ?uri WHERE { ?uri <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q21191270> . ?uri <http://www.wikidata.org/prop/direct/P361> <http://www.wikidata.org/entity/Q5274359> } ":
    "SELECT DISTINCT ?uri WHERE { ?uri <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q21191270> . ?uri <http://www.wikidata.org/prop/direct/P4908> <http://www.wikidata.org/entity/Q5274359> } ",

    // qald 7 fewshot
    // id: 15
    // inverse property path
    "SELECT DISTINCT ?uri WHERE {  <http://www.wikidata.org/entity/Q5620660> ^<http://www.wikidata.org/prop/qualifier/P453>/<http://www.wikidata.org/prop/statement/P161> ?uri } ":
    "SELECT DISTINCT ?uri WHERE { <https://www.wikidata.org/entity/Q1079> <http://www.wikidata.org/prop/P161> ?p. ?p <http://www.wikidata.org/prop/statement/P161> ?uri.?p <http://www.wikidata.org/prop/qualifier/P453> <http://www.wikidata.org/entity/Q5620660>.}",

    // id: 20
    // cannot be represented in thingtalk, switch to a simple question
    "SELECT (SUM(?goals) as ?total) WHERE { <http://www.wikidata.org/entity/Q12897> <http://www.wikidata.org/prop/P54> ?teamMembership .  ?teamMembership <http://www.wikidata.org/prop/qualifier/P1351> ?goals . }":
    `SELECT (COUNT(?teamMembership) as ?total) WHERE { <http://www.wikidata.org/entity/Q12897> <http://www.wikidata.org/prop/direct/P54> ?teamMembership }`,

    // id: 28
    // property path aggregation
    "SELECT DISTINCT ?date WHERE {  <http://www.wikidata.org/entity/Q76334> <http://www.wikidata.org/prop/P106>/<http://www.wikidata.org/prop/qualifier/P582> ?date }":
    "SELECT DISTINCT ?date WHERE {  <http://www.wikidata.org/entity/Q76334> <http://www.wikidata.org/prop/P106> ?p. ?p <http://www.wikidata.org/prop/qualifier/P582> ?date }",

    // id: 40
    "SELECT DISTINCT ?uri WHERE { <http://www.wikidata.org/entity/Q11297> <http://www.wikidata.org/prop/direct/P131> ?uri . { ?uri <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q515> . } UNION {?uri <http://www.wikidata.org/prop/direct/P31>/<http://www.wikidata.org/prop/direct/P279> <http://www.wikidata.org/entity/Q515> . } }":
    `SELECT DISTINCT ?uri WHERE { <http://www.wikidata.org/entity/Q11297> <http://www.wikidata.org/prop/direct/P131> ?uri . ?uri <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q515> . }`,

    // id: 44
    // bad annotation
    "SELECT DISTINCT ?s WHERE { <http://www.wikidata.org/entity/Q43274> <http://www.w3.org/2004/02/skos/core#altLabel> ?s  . }":
    "SELECT DISTINCT ?x ?y WHERE { <http://www.wikidata.org/entity/Q43274> <http://www.wikidata.org/prop/direct/P735> ?x. <http://www.wikidata.org/entity/Q43274> <http://www.wikidata.org/prop/direct/P734> ?y. }",

    // id: 71 
    // bad annotation
    "SELECT DISTINCT ?date WHERE {  <http://www.wikidata.org/entity/Q53713> <http://www.wikidata.org/prop/P570> ?date }":
    "SELECT DISTINCT ?date WHERE { <http://www.wikidata.org/entity/Q53713> <http://www.wikidata.org/prop/direct/P570> ?date }",

    // id: 78
    // complicated instance of 
    "SELECT DISTINCT ?uri WHERE { { ?uri <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q483110> .  } UNION { ?uri <http://www.wikidata.org/prop/direct/P31> ?type . ?type <http://www.wikidata.org/prop/direct/P279> <http://www.wikidata.org/entity/Q483110> } ?uri <http://www.wikidata.org/prop/direct/P17> <http://www.wikidata.org/entity/Q29> .  ?uri <http://www.wikidata.org/prop/direct/P1083> ?num .  } ORDER BY DESC(?num) LIMIT 1":
    "SELECT DISTINCT ?uri WHERE { ?uri <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q483110> . ?uri <http://www.wikidata.org/prop/direct/P17> <http://www.wikidata.org/entity/Q29> .  ?uri <http://www.wikidata.org/prop/direct/P1083> ?num .  } ORDER BY DESC(?num) LIMIT 1",

    // id: 80
    // not exist
    "SELECT DISTINCT ?height WHERE { ?uri <http://www.wikidata.org/prop/direct/P106>  <http://www.wikidata.org/entity/Q3665646> . ?uri <http://www.wikidata.org/prop/direct/P54>/<http://www.wikidata.org/prop/direct/P118> <http://www.wikidata.org/entity/Q155223> .  ?uri <http://www.wikidata.org/prop/P54> ?teamMembership . FILTER NOT EXISTS { ?teamMembership <http://www.wikidata.org/prop/qualifier/P582> ?endDate } ?uri  <http://www.wikidata.org/prop/direct/P2048> ?height } ORDER BY ?height LIMIT 1":
    "SELECT DISTINCT ?height WHERE { ?uri <http://www.wikidata.org/prop/direct/P106>  <http://www.wikidata.org/entity/Q3665646> . ?uri <http://www.wikidata.org/prop/direct/P54>/<http://www.wikidata.org/prop/direct/P118> <http://www.wikidata.org/entity/Q155223> .  ?uri  <http://www.wikidata.org/prop/direct/P2048> ?height } ORDER BY ?height LIMIT 1",

    // id: 82
    "SELECT DISTINCT ?uri WHERE {  <http://www.wikidata.org/entity/Q159> <http://www.wikidata.org/prop/P122> ?q . ?q <http://www.wikidata.org/prop/statement/P122> ?uri . FILTER NOT EXISTS { ?q <http://www.wikidata.org/prop/qualifier/P582> ?x }} ":
    "SELECT DISTINCT ?uri WHERE {  <http://www.wikidata.org/entity/Q159> <http://www.wikidata.org/prop/direct/P122> ?uri . }"
};

export const MANUAL_CONVERSION_WITH_DISPLAY : Record<string, string> = {
    // qald 7 test
    // id: 8
    "SELECT DISTINCT ?uri WHERE { ?uri <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q6256>  . ?cave <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q35509> . { ?cave <http://www.wikidata.org/prop/direct/P17> ?uri . }  UNION { ?cave <http://www.wikidata.org/prop/direct/P131>/<http://www.wikidata.org/prop/direct/P17> ?uri . } } GROUP BY ?uri HAVING (COUNT(DISTINCT ?cave) > 10)" : 
    `[country] of count(@${TP_DEVICE_NAME}.landform() filter instance_of == "Q6256"^^${TP_DEVICE_NAME}:landform_subdomain("cave")) by country filter count >= 10;`,
    // id: 14
    "ASK WHERE { { SELECT ?largest WHERE { ?largest <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q515> . ?largest <http://www.wikidata.org/prop/direct/P17> <http://www.wikidata.org/entity/Q79> . ?largest <http://www.wikidata.org/prop/direct/P1082> ?population . } ORDER BY DESC(?population) LIMIT 1 } <http://www.wikidata.org/entity/Q79> <http://www.wikidata.org/prop/direct/P36> ?largest . }": 
    `[contains(capital_of, "Q79"^^${TP_DEVICE_NAME}:country("egypts"))] of sort (population desc of @${TP_DEVICE_NAME}.city() filter contains(country, "Q79"^^${TP_DEVICE_NAME}:p_country("egypts")));`,
    // id: 29
    "SELECT DISTINCT ?date WHERE { <http://www.wikidata.org/entity/Q211> <http://www.wikidata.org/prop/P463> ?membership . ?membership <http://www.wikidata.org/prop/statement/P463> <http://www.wikidata.org/entity/Q458> . ?membership <http://www.wikidata.org/prop/qualifier/P580> ?date . }" : 
    `[start_time of (member_of filter value == "Q458"^^${TP_DEVICE_NAME}:p_member_of("eu"))] of @${TP_DEVICE_NAME}.country() filter id == "Q211"^^${TP_DEVICE_NAME}:country("latvia");`,

    // qald 7 train
    // id: 34
    "SELECT (COUNT(DISTINCT ?uri) as ?count) WHERE { <http://www.wikidata.org/entity/Q83233> <http://www.wikidata.org/prop/direct/P40>/<http://www.wikidata.org/prop/direct/P40> ?uri }":
    `count(@wd.human() filter in_array(id, any([<child/child>] of @wd.entity() filter id == "Q83233"^^wd:human("jacques cousteau"))));`,

    // id: 48
    // year filter not supported
    "SELECT DISTINCT ?uri WHERE { ?uri <http://www.wikidata.org/prop/direct/P39>/<http://www.wikidata.org/prop/direct/P279> <http://www.wikidata.org/entity/Q30461> . ?uri <http://www.wikidata.org/prop/direct/P569> ?date . FILTER(year(?date)=1945) }":
    `@wd.human() filter contains( position_held, "Q30461"^^wd:p_position_held ("presidents")) && date_of_birth >= new Date(1945,,) && date_of_birth <= new Date(1945,,) + 1year;`,

    // id: 66
    "SELECT DISTINCT ?uri WHERE {  { ?volcano <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q8072> . } UNION { ?volcano <http://www.wikidata.org/prop/direct/P31> ?type . ?type <http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/Q8072> . } ?volcano <http://www.wikidata.org/prop/direct/P17> ?uri . } GROUP BY ?uri HAVING(COUNT(?volcano)>10)":
    `count(@wd.entity() filter instance_of == "Q8072"^^wd:entity_subdomain("volcanoes")) by country filter count >= 10;`,

    // reverse:
    // qald 7 test
    // id: 14
    '[ contains ( capital_of , " Q79 " ^^wd:entity ( " egypts " ) ) ] of sort ( population desc of @wd . entity ( ) filter instance_of == " Q515 " ^^wd:domain ( " city " ) && contains ( country , " Q79 " ^^wd:entity ( " egypts " ) ) ) ;': 
    "ASK WHERE { { SELECT ?largest WHERE { ?largest <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q515> . ?largest <http://www.wikidata.org/prop/direct/P17> <http://www.wikidata.org/entity/Q79> . ?largest <http://www.wikidata.org/prop/direct/P1082> ?population . } ORDER BY DESC(?population) LIMIT 1 } <http://www.wikidata.org/entity/Q79> <http://www.wikidata.org/prop/direct/P36> ?largest . }"
};

export const MANUAL_CONVERSION_WITHOUT_DISPLAY : Record<string, string> = {
    // qald 7 test
    // id: 8
    "SELECT DISTINCT ?uri WHERE { ?uri <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q6256>  . ?cave <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q35509> . { ?cave <http://www.wikidata.org/prop/direct/P17> ?uri . }  UNION { ?cave <http://www.wikidata.org/prop/direct/P131>/<http://www.wikidata.org/prop/direct/P17> ?uri . } } GROUP BY ?uri HAVING (COUNT(DISTINCT ?cave) > 10)" : 
    `[country] of count(@${TP_DEVICE_NAME}.landform() filter instance_of == "Q6256"^^${TP_DEVICE_NAME}:landform_subdomain) by country filter count >= 10;`,
    // id: 14
    "ASK WHERE { { SELECT ?largest WHERE { ?largest <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q515> . ?largest <http://www.wikidata.org/prop/direct/P17> <http://www.wikidata.org/entity/Q79> . ?largest <http://www.wikidata.org/prop/direct/P1082> ?population . } ORDER BY DESC(?population) LIMIT 1 } <http://www.wikidata.org/entity/Q79> <http://www.wikidata.org/prop/direct/P36> ?largest . }": 
    `[contains(capital_of, "Q79"^^${TP_DEVICE_NAME}:country)] of sort(population desc of @${TP_DEVICE_NAME}.city() filter contains(country, "Q79"^^${TP_DEVICE_NAME}:p_country));`,
    // id: 29
    "SELECT DISTINCT ?date WHERE { <http://www.wikidata.org/entity/Q211> <http://www.wikidata.org/prop/P463> ?membership . ?membership <http://www.wikidata.org/prop/statement/P463> <http://www.wikidata.org/entity/Q458> . ?membership <http://www.wikidata.org/prop/qualifier/P580> ?date . }" : 
    `[start_time of (member_of filter value == "Q458"^^${TP_DEVICE_NAME}:p_member_of)] of @${TP_DEVICE_NAME}.country() filter id == "Q211"^^${TP_DEVICE_NAME}:country;`,

    // qald 7 train
    // id: 34
    "SELECT (COUNT(DISTINCT ?uri) as ?count) WHERE { <http://www.wikidata.org/entity/Q83233> <http://www.wikidata.org/prop/direct/P40>/<http://www.wikidata.org/prop/direct/P40> ?uri }":
    `count (@wd.human() filter in_array(id, any([<child/child>] of @wd.entity() filter id == "Q83233"^^wd:human)));`,

    // id: 48
    // year filter not supported
    "SELECT DISTINCT ?uri WHERE { ?uri <http://www.wikidata.org/prop/direct/P39>/<http://www.wikidata.org/prop/direct/P279> <http://www.wikidata.org/entity/Q30461> . ?uri <http://www.wikidata.org/prop/direct/P569> ?date . FILTER(year(?date)=1945) }":
    `@wd.human() filter contains(position_held, "Q30461"^^wd:p_position_held) && date_of_birth >= new Date(1945,,) && date_of_birth <= new Date(1945,,) + 1year;`,

    // id: 66
    "SELECT DISTINCT ?uri WHERE {  { ?volcano <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q8072> . } UNION { ?volcano <http://www.wikidata.org/prop/direct/P31> ?type . ?type <http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/Q8072> . } ?volcano <http://www.wikidata.org/prop/direct/P17> ?uri . } GROUP BY ?uri HAVING(COUNT(?volcano)>10)":
    `count(@wd.entity() filter instance_of == "Q8072"^^wd:entity_subdomain) by country filter count >= 10;`,

    // reverse:
    // qald 7 test
    // id: 14
    '[ contains ( capital_of , " Q79 " ^^wd:entity ) ] of sort ( population desc of @wd . entity ( ) filter instance_of == " Q515 " ^^wd:domain && contains ( country , " Q79 " ^^wd:entity ) ) ;': 
    "ASK WHERE { { SELECT ?largest WHERE { ?largest <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q515> . ?largest <http://www.wikidata.org/prop/direct/P17> <http://www.wikidata.org/entity/Q79> . ?largest <http://www.wikidata.org/prop/direct/P1082> ?population . } ORDER BY DESC(?population) LIMIT 1 } <http://www.wikidata.org/entity/Q79> <http://www.wikidata.org/prop/direct/P36> ?largest . }"

};