import trainQuestions from '../../data/train.json';
import testQuestions from '../../data/test.json';

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
export function preprocessQALD() : Example[] {
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
    "Q5274359" : "the first season of the HBO television series The Sopranos".toLowerCase(),
    "Q4970706" : "federal chancellors of germany",
    "Q10800557" : "actors"
};